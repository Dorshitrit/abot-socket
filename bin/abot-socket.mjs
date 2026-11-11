#!/usr/bin/env node

// Check before loading node:sqlite so unsupported Node versions get a useful error.
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('ABot Socket requires Node.js 24 or later. Install a supported Node.js version first.');
  process.exitCode = 1;
} else {
  try {
    const { runEntry } = await import('../src/cli/cli-entry.mjs');
    process.exitCode = await runEntry(process.argv.slice(2));
  } catch {
    console.error('ABot Socket could not complete the command. Check the local configuration and installation.');
    process.exitCode = 1;
  }
}
