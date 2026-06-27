#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(repoRoot, 'server', 'src');
const distRoot = path.join(repoRoot, 'server', 'dist');

const markers = [
  'MAX_AGENT_CHILD_ISSUES_PER_RUN',
  'MAX_AGENT_CHILD_ISSUES_PER_ROLLING_DAY',
  'Agent child issue creation is capped at',
];

function usage() {
  console.log(`Usage: node scripts/preflight-dist-promotion.mjs [--build]

Verify Paperclip source/dist swarm-cap promotion readiness.

Default mode is read-only. --build runs:
  pnpm --filter @paperclipai/server build
`);
}

function walkFiles(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walkFiles(fullPath, files);
    } else if (/\.(js|ts|mjs|cjs)$/.test(entry)) {
      files.push(fullPath);
    }
  }
  return files;
}

function findMarkers(root) {
  const files = walkFiles(root);
  const hits = new Map(markers.map((marker) => [marker, []]));
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const marker of markers) {
      if (content.includes(marker)) {
        hits.get(marker).push(path.relative(repoRoot, file));
      }
    }
  }
  return Object.fromEntries(hits);
}

function allMarkersPresent(hits) {
  return markers.every((marker) => hits[marker]?.length > 0);
}

function launchdTarget() {
  const uid = process.getuid?.() ?? 501;
  const result = spawnSync('launchctl', ['print', `gui/${uid}/com.veya.paperclip`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return {
    ok: result.status === 0,
    runsDist: output.includes('server/dist/index.js'),
    excerpt: output
      .split('\n')
      .filter((line) => line.includes('program =') || line.includes('server/dist/index.js') || line.includes('working directory'))
      .map((line) => line.trim()),
  };
}

function runBuild() {
  execFileSync('pnpm', ['--filter', '@paperclipai/server', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

const args = new Set(process.argv.slice(2));
if (args.has('--help') || args.has('-h')) {
  usage();
  process.exit(0);
}

if (args.has('--build')) {
  runBuild();
}

const sourceHits = findMarkers(sourceRoot);
const distHits = findMarkers(distRoot);
const launchd = launchdTarget();
const result = {
  mode: args.has('--build') ? 'build-and-verify' : 'verify-only',
  repoRoot,
  sourceMarkersPresent: allMarkersPresent(sourceHits),
  distMarkersPresent: allMarkersPresent(distHits),
  launchdRunsDist: launchd.runsDist,
  launchd,
  sourceHits,
  distHits,
  nextGate:
    allMarkersPresent(sourceHits) && allMarkersPresent(distHits) && launchd.runsDist
      ? 'dist-ready-for-controlled-restart-approval'
      : 'hold-restart',
};

console.log(JSON.stringify(result, null, 2));

if (!result.sourceMarkersPresent || !result.distMarkersPresent || !result.launchdRunsDist) {
  process.exitCode = 1;
}
