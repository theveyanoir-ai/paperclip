/**
 * Verifier script: proves that a completed productivity review stays terminal
 * across an automation cycle.
 *
 * This script simulates the exact scenario:
 * 1. Create a source issue with trigger conditions (no-comment streak)
 * 2. Run reconcileProductivityReviews → creates a review
 * 3. Mark the review as "done" (simulating manager completion)
 * 4. Run reconcileProductivityReviews again (simulating next automation cycle)
 * 5. VERIFY: no new review is created (snoozed count increments)
 * 6. Also verify: if source issue gets updated AFTER review completion,
 *    a new review CAN be created (the escape hatch works)
 *
 * Run with: npx tsx server/src/__tests__/verify-respawn-fix.ts
 * Or integrate into the test suite.
 */

import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { issues } from "@paperclipai/db";
import {
  productivityReviewService,
  PRODUCTIVITY_REVIEW_ORIGIN_KIND,
  DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
  DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS,
} from "../services/productivity-review.js";

// This test should be added to the existing test file:
// server/src/__tests__/productivity-review-service.test.ts

describe("productivity review respawn lifecycle", () => {
  it("completed review stays terminal across automation cycles (no respawn)", async () => {
    const now = new Date("2026-06-28T00:00:00.000Z");
    const seeded = await seedAssignedIssue();

    // Create trigger conditions: no-comment streak
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const service = productivityReviewService(db);

    // Step 1: First reconciliation creates a review
    const first = await service.reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });
    expect(first.created).toBe(1);

    // Step 2: Mark the review as done (manager completed it)
    const [review] = await listProductivityReviews(seeded.companyId);
    await db
      .update(issues)
      .set({ status: "done", updatedAt: now })
      .where(eq(issues.id, review!.id));

    // Step 3: Run reconciliation AFTER the snooze window expires (7 hours later)
    const afterSnooze = new Date(
      now.getTime() + DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS + 60 * 60 * 1000,
    );
    const afterSnoozResult = await service.reconcileProductivityReviews({
      now: afterSnooze,
      companyId: seeded.companyId,
    });

    // VERIFY: No new review created — the lifecycle guard prevents respawn
    expect(afterSnoozResult.created).toBe(0);
    expect(afterSnoozResult.snoozed).toBe(1);

    // Step 4: Verify even 24 hours later, still no respawn
    const nextDay = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const nextDayResult = await service.reconcileProductivityReviews({
      now: nextDay,
      companyId: seeded.companyId,
    });
    expect(nextDayResult.created).toBe(0);
    expect(nextDayResult.snoozed).toBe(1);

    // Total reviews should still be just 1
    const allReviews = await listProductivityReviews(seeded.companyId);
    expect(allReviews).toHaveLength(1);
  });

  it("allows new review if source issue updated AFTER review completion", async () => {
    const now = new Date("2026-06-28T00:00:00.000Z");
    const seeded = await seedAssignedIssue();

    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const service = productivityReviewService(db);

    // Create and complete a review
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const [review] = await listProductivityReviews(seeded.companyId);
    await db
      .update(issues)
      .set({ status: "done", updatedAt: now })
      .where(eq(issues.id, review!.id));

    // Simulate new activity on the source issue AFTER the review was completed
    const laterActivity = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    await db
      .update(issues)
      .set({ updatedAt: laterActivity })
      .where(eq(issues.id, seeded.issueId));

    // Add more runs to re-trigger evidence
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now: laterActivity,
    });

    // Reconcile after the source issue was updated
    const result = await service.reconcileProductivityReviews({
      now: laterActivity,
      companyId: seeded.companyId,
    });

    // VERIFY: A new review IS created because source issue has new activity
    expect(result.created).toBe(1);
  });
});
