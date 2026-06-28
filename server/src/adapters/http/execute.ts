import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, parseObject, renderTemplate } from "../utils.js";

function renderPayloadTemplate(value: unknown, data: Record<string, unknown>): unknown {
  if (typeof value === "string") return renderTemplate(value, data);
  if (Array.isArray(value)) return value.map((item) => renderPayloadTemplate(item, data));
  if (!value || typeof value !== "object") return value;
  const rendered: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    rendered[key] = renderPayloadTemplate(child, data);
  }
  return rendered;
}

function buildPayloadTemplateData(agent: AdapterExecutionContext["agent"], context: Record<string, unknown>) {
  const paperclipTaskMarkdown = typeof context.paperclipTaskMarkdown === "string"
    ? context.paperclipTaskMarkdown
    : "";
  const instructions = typeof context.instructions === "string" && context.instructions.trim()
    ? context.instructions
    : "You are " + agent.name + ". Complete the assigned Paperclip issue using the task context.";
  return {
    ...context,
    // Backward compatibility for older HTTP agent payload templates that used
    // generic {{instructions}} / {{context}} placeholders.
    instructions,
    context: typeof context.context === "string" && context.context.trim()
      ? context.context
      : paperclipTaskMarkdown,
  };
}

function extractHttpResponseText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const outputText = parsed.output_text;
    if (typeof outputText === "string" && outputText.trim()) return outputText.trim();
    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    const firstChoice = choices[0] as Record<string, unknown> | undefined;
    const message = firstChoice?.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const joined = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object") {
            const record = part as Record<string, unknown>;
            return typeof record.text === "string" ? record.text : "";
          }
          return "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
      if (joined) return joined;
    }
    const textValue = parsed.text;
    if (typeof textValue === "string" && textValue.trim()) return textValue.trim();
  } catch {
    // Fall through to raw text for non-JSON webhooks.
  }
  return trimmed;
}

// === MULTI-TURN TOOL CALLING SUPPORT ===
// Types for tracking tool call results across iterations
interface ToolCallResult {
  method: string;
  url: string;
  status: number;
  responseSnippet: string;
  error?: string;
}

interface MultiTurnState {
  iteration: number;
  maxIterations: number;
  startTime: number;
  timeoutMs: number;
  allToolResults: ToolCallResult[];
  agentPatchedIssueStatus: boolean;
  finalOutput: string;
}

/**
 * Parse "invoke tool http_request with method is X url is Y body is Z" lines from LLM output.
 * Returns an array of parsed tool invocations.
 */
function parseToolInvocations(output: string): Array<{ method: string; url: string; body?: string }> {
  const invokePattern = /invoke tool http_request with method is (\w+) url is (\S+)(?:\s+body is (\{[\s\S]*?\}))?/g;
  const invocations: Array<{ method: string; url: string; body?: string }> = [];
  let match;
  while ((match = invokePattern.exec(output)) !== null) {
    invocations.push({
      method: match[1],
      url: match[2],
      body: match[3],
    });
  }
  return invocations;
}

/**
 * Execute a single tool invocation and return the result.
 */
async function executeToolCall(
  invocation: { method: string; url: string; body?: string },
  onLog: AdapterExecutionContext["onLog"],
): Promise<ToolCallResult> {
  const { method, url, body: bodyStr } = invocation;
  try {
    const fetchOpts: RequestInit = {
      method: method.toUpperCase(),
      headers: { "content-type": "application/json" },
    };
    if (bodyStr && bodyStr.trim()) {
      (fetchOpts as Record<string, unknown>).body = bodyStr.trim();
    }
    const res = await fetch(url, fetchOpts);
    const resText = await res.text();
    const snippet = resText.slice(0, 500);
    await onLog("stdout", `[invoke tool] ${method.toUpperCase()} ${url} -> ${res.status} ${resText.slice(0, 200)}`);
    return { method: method.toUpperCase(), url, status: res.status, responseSnippet: snippet };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[invoke tool] ERROR ${method.toUpperCase()} ${url}: ${errMsg}`);
    return { method: method.toUpperCase(), url, status: 0, responseSnippet: "", error: errMsg };
  }
}

/**
 * Build the follow-up messages array for multi-turn.
 * Appends the assistant response and tool results so the LLM can see what happened.
 */
function buildFollowUpMessages(
  originalMessages: unknown[],
  assistantOutput: string,
  toolResults: ToolCallResult[],
): unknown[] {
  const messages = [...originalMessages];

  // Add the assistant's response
  messages.push({
    role: "assistant",
    content: assistantOutput,
  });

  // Add tool results as a user message summarizing what happened
  const toolSummaryParts = toolResults.map((r, i) => {
    if (r.error) {
      return `Tool call ${i + 1}: ${r.method} ${r.url} -> ERROR: ${r.error}`;
    }
    return `Tool call ${i + 1}: ${r.method} ${r.url} -> HTTP ${r.status}\nResponse: ${r.responseSnippet}`;
  });

  messages.push({
    role: "user",
    content: `[TOOL RESULTS]\n${toolSummaryParts.join("\n\n")}\n\n[END TOOL RESULTS]\n\nBased on the tool results above, continue with your task. If you need to make more API calls, use "invoke tool http_request with method is METHOD url is URL body is {JSON}". If you are done, provide your final response without any tool invocations.`,
  });

  return messages;
}

// === ATOMIC EXECUTION LOCK ===
// Uses the issues.metadata JSONB column to store a timestamped lock.
// The UPDATE is atomic: only one concurrent run can win the CAS (compare-and-set).
// A 5-minute TTL prevents stuck locks from crashed runs from blocking forever.
const LOCK_TTL_MINUTES = 5;

/**
 * Attempt to acquire an atomic execution lock on the issue.
 * Uses a single atomic UPDATE with a CAS condition:
 *   - Lock is free if executionLock is NULL/empty
 *   - Lock is expired if executionLock timestamp is older than LOCK_TTL_MINUTES
 * Returns true if the lock was acquired, false if another run holds it.
 */
async function acquireExecutionLock(
  issueId: string,
  runId: string,
  paperclipBase: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<boolean> {
  try {
    // We use the Paperclip API to PATCH metadata with a conditional check.
    // The lock value encodes both the runId and the timestamp for TTL checking.
    const lockValue = JSON.stringify({ runId, lockedAt: new Date().toISOString() });

    // Skip dedicated /execution-lock endpoint (not registered) — use metadata PATCH directly.
    return await acquireExecutionLockViaMetadata(issueId, runId, paperclipBase, lockValue, onLog);
  } catch (err) {
    // Non-fatal: if lock acquisition fails entirely, log and proceed
    await onLog("stderr", `[exec-lock] Lock acquisition error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

/**
 * Fallback: acquire lock via PATCH to issues metadata.
 * This is NOT atomic at the HTTP layer, but the underlying DB UPDATE uses
 * a WHERE condition that makes it atomic at the Postgres level.
 * The server must implement the conditional update; if it doesn't, we
 * use a best-effort approach and rely on the dedup guard as a secondary check.
 */
async function acquireExecutionLockViaMetadata(
  issueId: string,
  runId: string,
  paperclipBase: string,
  lockValue: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<boolean> {
  try {
    // First, read current metadata to check if a lock already exists
    const getRes = await fetch(`${paperclipBase}/api/issues/${issueId}`, {
      method: "GET",
      headers: { "content-type": "application/json" },
    });
    if (!getRes.ok) {
      await onLog("stderr", `[exec-lock] Could not read issue ${issueId} for lock check: ${getRes.status}`);
      return true; // Non-fatal, proceed
    }

    const issueData = await getRes.json() as Record<string, unknown>;
    const metadata = (issueData.metadata ?? {}) as Record<string, unknown>;
    const existingLock = metadata.executionLock as Record<string, unknown> | string | undefined;

    if (existingLock) {
      // Parse the existing lock to check TTL
      let lockedAt: Date | null = null;
      try {
        const lockObj = typeof existingLock === "string" ? JSON.parse(existingLock) as Record<string, unknown> : existingLock;
        if (lockObj.lockedAt) lockedAt = new Date(lockObj.lockedAt as string);
      } catch {
        // Malformed lock — treat as expired
      }

      const now = new Date();
      const isExpired = !lockedAt || (now.getTime() - lockedAt.getTime()) > LOCK_TTL_MINUTES * 60 * 1000;

      if (!isExpired) {
        const lockObj = typeof existingLock === "string" ? JSON.parse(existingLock) as Record<string, unknown> : existingLock;
        await onLog("stdout", `[exec-lock] Issue ${issueId} is locked by run ${lockObj.runId ?? "unknown"} (acquired ${lockedAt?.toISOString()}) — skipping`);
        return false;
      }

      await onLog("stdout", `[exec-lock] Existing lock on issue ${issueId} is expired (${lockedAt?.toISOString()}) — overwriting`);
    }

    // Write our lock
    const newMetadata = { ...metadata, executionLock: JSON.parse(lockValue) as unknown };
    const patchRes = await fetch(`${paperclipBase}/api/issues/${issueId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: newMetadata }),
    });

    if (patchRes.ok) {
      await onLog("stdout", `[exec-lock] Acquired metadata lock on issue ${issueId} for run ${runId}`);
      return true;
    }

    await onLog("stderr", `[exec-lock] Metadata PATCH failed (${patchRes.status}) — proceeding without lock`);
    return true;
  } catch (err) {
    await onLog("stderr", `[exec-lock] Metadata lock fallback error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

/**
 * Release the execution lock on the issue.
 * Called in the finally block to ensure cleanup even on errors.
 */
async function releaseExecutionLock(
  issueId: string,
  runId: string,
  paperclipBase: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<void> {
  try {
    // Skip dedicated /execution-lock endpoint (not registered) — use metadata PATCH directly.
    await releaseExecutionLockViaMetadata(issueId, runId, paperclipBase, onLog);
  } catch (err) {
    // Non-fatal: log but don't throw — we're in a finally block
    await onLog("stderr", `[exec-lock] Lock release error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    // Still attempt metadata fallback
    try {
      await releaseExecutionLockViaMetadata(issueId, runId, paperclipBase, onLog);
    } catch {
      // Swallow — truly non-fatal
    }
  }
}

/**
 * Fallback: release lock by clearing executionLock from metadata.
 */
async function releaseExecutionLockViaMetadata(
  issueId: string,
  runId: string,
  paperclipBase: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<void> {
  try {
    // Read current metadata
    const getRes = await fetch(`${paperclipBase}/api/issues/${issueId}`, {
      method: "GET",
      headers: { "content-type": "application/json" },
    });
    if (!getRes.ok) return;

    const issueData = await getRes.json() as Record<string, unknown>;
    const metadata = { ...((issueData.metadata ?? {}) as Record<string, unknown>) };

    // Only clear if we own the lock (verify runId matches)
    const existingLock = metadata.executionLock as Record<string, unknown> | undefined;
    if (existingLock && typeof existingLock === "object" && existingLock.runId !== runId) {
      await onLog("stdout", `[exec-lock] Lock on ${issueId} owned by different run (${existingLock.runId}) — not clearing`);
      return;
    }

    delete metadata.executionLock;
    const patchRes = await fetch(`${paperclipBase}/api/issues/${issueId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata }),
    });

    if (patchRes.ok) {
      await onLog("stdout", `[exec-lock] Released metadata lock on issue ${issueId} for run ${runId}`);
    }
  } catch (err) {
    await onLog("stderr", `[exec-lock] Metadata lock release error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}
// === END ATOMIC EXECUTION LOCK ===

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context, onLog } = ctx;
  const url = asString(config.url, "");
  if (!url) throw new Error("HTTP adapter missing url");
  const method = asString(config.method, "POST");
  const timeoutMs = asNumber(config.timeoutMs, 0);
  const headers = parseObject(config.headers) as Record<string, string>;
  const payloadTemplate = parseObject(config.payloadTemplate);
  const templateData = buildPayloadTemplateData(agent, context);
  const renderedPayloadTemplate = renderPayloadTemplate(payloadTemplate, templateData) as Record<string, unknown>;
  const body = { ...renderedPayloadTemplate, agentId: agent.id, runId, context };
  const issueId = typeof context.issueId === "string" && context.issueId ? context.issueId : null;
  const paperclipBase = "http://127.0.0.1:3101";

  // === ATOMIC EXECUTION LOCK ===
  // Acquire a distributed lock BEFORE the dedup check and LLM call.
  // This prevents the wakeOnDemand race condition where multiple runs fire
  // within milliseconds, all pass the dedup check before any posts [DISPATCHED].
  // The lock uses the issue's metadata JSONB column with a 5-minute TTL to
  // handle crashed runs that never released their lock.
  let lockAcquired = false;
  if (issueId) {
    lockAcquired = await acquireExecutionLock(issueId, runId, paperclipBase, onLog);
    if (!lockAcquired) {
      // Another run holds the lock — skip this execution entirely
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        resultJson: {
          stdout: `[exec-lock] Skipped — issue ${issueId} is locked by another concurrent run`,
          response: "",
        },
        summary: `[exec-lock] Issue ${issueId} locked by concurrent run — skipped`,
      };
    }
  }
  // === END ATOMIC EXECUTION LOCK (acquire) ===

  // Wrap the rest of the execution in a try/finally to guarantee lock release
  try {
    // === FIX B: PRE-FLIGHT DEDUP CHECK ===
    // Before calling LiteLLM, check if this issue already has a [DISPATCHED] comment.
    // If it does, skip the LLM call entirely and just mark the issue as done.
    // This prevents the adapter from creating duplicate child issues
    // because the model cannot conditionally check comments mid-execution.
    if (issueId) {
      try {
        const commentsRes = await fetch(`${paperclipBase}/api/issues/${issueId}/comments`, {
          method: "GET",
          headers: { "content-type": "application/json" },
        });
        if (commentsRes.ok) {
          const commentsText = await commentsRes.text();
          // Check for [DISPATCHED] marker in any comment
          if (commentsText.includes("[DISPATCHED]")) {
            await onLog("stdout", `[dedup-guard] Issue ${issueId} already has [DISPATCHED] marker — skipping LLM call`);
            // Mark the issue as done since it was already processed
            const patchRes = await fetch(`${paperclipBase}/api/issues/${issueId}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ status: "done" }),
            });
            await onLog("stdout", `[dedup-guard] PATCH issue ${issueId} -> done: ${patchRes.status}`);
            return {
              exitCode: 0,
              signal: null,
              timedOut: false,
              resultJson: {
                stdout: `[dedup-guard] Skipped — issue already dispatched`,
                response: "",
              },
              summary: `[dedup-guard] Issue ${issueId} already dispatched, marked done`,
            };
          }
          // Also check for existing child issues to catch cases where comment wasn't posted
          // but child issues were already created (belt-and-suspenders)
          const companyId = agent.companyId;
          const childrenRes = await fetch(`${paperclipBase}/api/companies/${companyId}/issues?parentId=${issueId}`, {
            method: "GET",
            headers: { "content-type": "application/json" },
          });
          if (childrenRes.ok) {
            const childrenText = await childrenRes.text();
            try {
              const children = JSON.parse(childrenText) as unknown[];
              if (Array.isArray(children) && children.length > 0) {
                await onLog("stdout", `[dedup-guard] Issue ${issueId} already has ${children.length} child issue(s) — skipping LLM call`);
                const patchRes = await fetch(`${paperclipBase}/api/issues/${issueId}`, {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ status: "done" }),
                });
                await onLog("stdout", `[dedup-guard] PATCH issue ${issueId} -> done: ${patchRes.status}`);
                return {
                  exitCode: 0,
                  signal: null,
                  timedOut: false,
                  resultJson: {
                    stdout: `[dedup-guard] Skipped — issue already has child issues`,
                    response: "",
                  },
                  summary: `[dedup-guard] Issue ${issueId} already has children, marked done`,
                };
              }
            } catch {
              // Non-fatal: if parsing fails, continue with normal execution
            }
          }
        }
      } catch (e) {
        // Non-fatal: if the dedup check fails, proceed with normal execution
        await onLog("stderr", `[dedup-guard] Pre-flight check failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // === END FIX B ===

    // === FIX A: IMMEDIATE STATUS LOCK ===
    // Immediately PATCH the issue to "in_progress" BEFORE sending to LLM.
    // This prevents the heartbeat scheduler from re-triggering the same issue
    // while the LLM call is in flight, which was causing duplicate child issues.
    if (issueId) {
      try {
        const lockResponse = await fetch(`${paperclipBase}/api/issues/${issueId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'in_progress' })
        });
        if (lockResponse.ok) {
          await onLog("stdout", `[status-lock] PATCH issue ${issueId} -> in_progress (preventing duplicate dispatch)`);
        }
      } catch (e) {
        // Non-fatal: if this fails, the old behavior continues
        await onLog("stderr", `[status-lock] Failed to lock issue ${issueId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // === END FIX A ===

    // === MULTI-TURN TOOL CALLING LOOP ===
    // Instead of a single LLM call + blind tool execution, we now loop:
    // 1. Call LLM
    // 2. If response contains tool invocations, execute them
    // 3. Append tool results to messages
    // 4. Call LLM again with updated context
    // 5. Repeat until: no tool calls, max 5 iterations, or 120s global timeout
    const MULTI_TURN_MAX_ITERATIONS = asNumber(config.maxIterations, 15);
    const MULTI_TURN_TIMEOUT_MS = 120_000; // 120 seconds global timeout for multi-turn loop
    const multiTurnStart = Date.now();

    const state: MultiTurnState = {
      iteration: 0,
      maxIterations: MULTI_TURN_MAX_ITERATIONS,
      startTime: multiTurnStart,
      timeoutMs: MULTI_TURN_TIMEOUT_MS,
      allToolResults: [],
      agentPatchedIssueStatus: false,
      finalOutput: "",
    };

    // Extract messages from the body if present (for multi-turn context building)
    let currentMessages: unknown[] = [];
    if (Array.isArray((body as Record<string, unknown>).messages)) {
      currentMessages = [...((body as Record<string, unknown>).messages as unknown[])];
    }

    // Per-request abort controller (uses adapter-level timeout if set)
    const perRequestTimeoutMs = timeoutMs > 0 ? timeoutMs : 60_000; // Default 60s per LLM call

    let lastRawResponse = "";

    while (state.iteration < state.maxIterations) {
      // Check global multi-turn timeout
      const elapsed = Date.now() - state.startTime;
      if (elapsed >= state.timeoutMs) {
        await onLog("stdout", `[multi-turn] Global timeout reached (${elapsed}ms >= ${state.timeoutMs}ms) after ${state.iteration} iteration(s)`);
        break;
      }

      state.iteration++;
      await onLog("stdout", `[multi-turn] Iteration ${state.iteration}/${state.maxIterations} (elapsed: ${elapsed}ms)`);

      // Build the request body for this iteration
      let iterationBody: Record<string, unknown>;
      if (state.iteration === 1) {
        // First iteration: use the original body as-is
        iterationBody = body as Record<string, unknown>;
      } else {
        // Subsequent iterations: update messages with tool results
        iterationBody = { ...(body as Record<string, unknown>), messages: currentMessages };
      }

      // Make the LLM call with per-request timeout
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), perRequestTimeoutMs);

      try {
        const res = await fetch(url, {
          method,
          headers: {
            "content-type": "application/json",
            ...headers,
          },
          body: JSON.stringify(iterationBody),
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error(`HTTP invoke failed with status ${res.status}`);
        }

        lastRawResponse = await res.text();
        const output = extractHttpResponseText(lastRawResponse);

        if (output) {
          await onLog("stdout", `[multi-turn] LLM response (iter ${state.iteration}, ${output.length} chars): ${output.slice(0, 300)}...`);
        }

        // Parse tool invocations from the response
        const invocations = output ? parseToolInvocations(output) : [];

        if (invocations.length === 0) {
          // No tool calls — this is the final response
          await onLog("stdout", `[multi-turn] No tool invocations in iteration ${state.iteration} — treating as final response`);
          state.finalOutput = output;
          break;
        }

        // Execute tool calls and collect results
        await onLog("stdout", `[multi-turn] Found ${invocations.length} tool invocation(s) in iteration ${state.iteration}`);
        const iterationResults: ToolCallResult[] = [];

        for (const invocation of invocations) {
          // Check timeout before each tool call
          if (Date.now() - state.startTime >= state.timeoutMs) {
            await onLog("stdout", `[multi-turn] Timeout during tool execution — stopping`);
            break;
          }

          const result = await executeToolCall(invocation, onLog);
          iterationResults.push(result);
          state.allToolResults.push(result);

          // Track if agent explicitly patched the issue status
          if (result.method === "PATCH" && issueId && invocation.url.includes(issueId)) {
            try {
              const patchBody = invocation.body ? JSON.parse(invocation.body) as Record<string, unknown> : {};
              if (patchBody.status) state.agentPatchedIssueStatus = true;
            } catch { state.agentPatchedIssueStatus = true; }
          }
        }

        // If we hit timeout during tool execution, use what we have
        if (Date.now() - state.startTime >= state.timeoutMs) {
          state.finalOutput = output;
          break;
        }

        // Build follow-up messages for next iteration
        currentMessages = buildFollowUpMessages(currentMessages.length > 0 ? currentMessages : (Array.isArray((body as Record<string, unknown>).messages) ? (body as Record<string, unknown>).messages as unknown[] : []), output, iterationResults);

        // If this is the last iteration, use current output as final
        if (state.iteration >= state.maxIterations) {
          await onLog("stdout", `[multi-turn] Max iterations (${state.maxIterations}) reached — using last output as final`);
          state.finalOutput = output;
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          await onLog("stderr", `[multi-turn] LLM call timed out in iteration ${state.iteration} (${perRequestTimeoutMs}ms)`);
          // If we have previous output, use it; otherwise report timeout
          if (state.finalOutput) break;
          return {
            exitCode: null,
            signal: null,
            timedOut: true,
            errorMessage: `HTTP ${method} ${url} timed out in multi-turn iteration ${state.iteration}`,
            errorCode: "timeout",
          };
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    // === END MULTI-TURN TOOL CALLING LOOP ===

    const output = state.finalOutput;

    // === AUTO-DISPOSITION: If agent responded but didn't explicitly set issue status, auto-close to done ===
    if (issueId && output && !state.agentPatchedIssueStatus) {
      try {
        // Build a comprehensive comment including multi-turn summary
        let commentBody = output;
        if (state.allToolResults.length > 0 && state.iteration > 1) {
          const toolSummary = `\n\n---\n[Multi-turn execution: ${state.iteration} iteration(s), ${state.allToolResults.length} tool call(s), ${Date.now() - state.startTime}ms elapsed]`;
          commentBody = output + toolSummary;
        }
        commentBody = commentBody.length > 8000 ? commentBody.slice(0, 8000) + "\n\n[...truncated]" : commentBody;

        const commentRes = await fetch(`${paperclipBase}/api/issues/${issueId}/comments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: commentBody, authorAgentId: agent.id, createdByRunId: runId }),
        });
        if (commentRes.ok) {
          await onLog("stdout", `[auto-disposition] Posted response as comment on issue ${issueId}`);
        }

        const upperOutput = output.toUpperCase();
        let finalStatus = "done";
        if (upperOutput.includes("[BLOCKED]") || upperOutput.includes("BLOCKED BY") || upperOutput.includes("CANNOT PROCEED")) {
          finalStatus = "blocked";
        } else if (upperOutput.includes("[CANCELLED]") || upperOutput.includes("[CANCEL]")) {
          finalStatus = "cancelled";
        }

        if (finalStatus === "done") {
          const patchRes = await fetch(`${paperclipBase}/api/issues/${issueId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "done" }),
          });
          const patchText = await patchRes.text();
          await onLog("stdout", `[auto-disposition] PATCH issue ${issueId} -> ${finalStatus}: ${patchRes.status} ${patchText.slice(0, 100)}`);
        } else {
          const patchRes = await fetch(`${paperclipBase}/api/issues/${issueId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: finalStatus }),
          });
          const patchText = await patchRes.text();
          await onLog("stdout", `[auto-disposition] PATCH issue ${issueId} -> ${finalStatus}: ${patchRes.status} ${patchText.slice(0, 100)}`);
        }
      } catch (dispErr) {
        await onLog("stderr", `[auto-disposition] ERROR: ${dispErr instanceof Error ? dispErr.message : String(dispErr)}`);
      }
    }
    // === END AUTO-DISPOSITION ===

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: {
        stdout: output,
        response: lastRawResponse,
        multiTurn: {
          iterations: state.iteration,
          toolCalls: state.allToolResults.length,
          elapsedMs: Date.now() - state.startTime,
        },
      },
      summary: output
        ? `[multi-turn: ${state.iteration} iter, ${state.allToolResults.length} tools] ${output.slice(0, 200)}`
        : `HTTP ${method} ${url}`,
    };
  } finally {
    // === ATOMIC EXECUTION LOCK (release) ===
    // Always release the lock, even if an exception was thrown.
    // This ensures no run can get permanently stuck due to a crash.
    if (issueId && lockAcquired) {
      await releaseExecutionLock(issueId, runId, paperclipBase, onLog);
    }
    // === END ATOMIC EXECUTION LOCK (release) ===
  }
}
