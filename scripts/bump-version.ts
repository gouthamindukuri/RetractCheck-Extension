#!/usr/bin/env bun
/**
 * Bump version across all manifests and package.json files.
 * Usage: bun scripts/bump-version.ts <version|patch|minor|major>
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');

const MANIFEST_FILES = [
  'apps/extension/public/manifest.json',
  'apps/extension/public/manifest.firefox.json',
  'apps/extension/public/manifest.edge.json',
];

const PACKAGE_FILES = [
  'apps/extension/package.json',
  'apps/api/package.json',
  'packages/config/package.json',
  'packages/doi/package.json',
  'packages/types/package.json',
];

function parseVersion(version: string): [number, number, number] {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid version format: ${version}`);
  }
  return parts as [number, number, number];
}

function bumpVersion(current: string, type: 'patch' | 'minor' | 'major'): string {
  const [major, minor, patch] = parseVersion(current);
  switch (type) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
  }
}

function getCurrentVersion(): string {
  const manifestPath = join(ROOT, MANIFEST_FILES[0]);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  return manifest.version;
}

function updateJsonFile(filePath: string, newVersion: string): boolean {
  const fullPath = join(ROOT, filePath);
  if (!existsSync(fullPath)) {
    console.warn(`  Skipping (not found): ${filePath}`);
    return false;
  }

  const content = readFileSync(fullPath, 'utf-8');
  const json = JSON.parse(content);
  const oldVersion = json.version;

  if (oldVersion === newVersion) {
    console.log(`  Already at ${newVersion}: ${filePath}`);
    return false;
  }

  json.version = newVersion;
  writeFileSync(fullPath, JSON.stringify(json, null, 2) + '\n');
  console.log(`  ${oldVersion} -> ${newVersion}: ${filePath}`);
  return true;
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: bun scripts/bump-version.ts <version|patch|minor|major>');
    console.log(`Current version: ${getCurrentVersion()}`);
    process.exit(1);
  }

  const input = args[0];
  const currentVersion = getCurrentVersion();
  let newVersion: string;

  if (['patch', 'minor', 'major'].includes(input)) {
    newVersion = bumpVersion(currentVersion, input as 'patch' | 'minor' | 'major');
  } else if (/^\d+\.\d+\.\d+$/.test(input)) {
    newVersion = input;
  } else {
    console.error(`Invalid version: ${input}`);
    process.exit(1);
  }

  console.log(`Bumping: ${currentVersion} -> ${newVersion}\n`);

  let count = 0;

  console.log('Manifests:');
  for (const file of MANIFEST_FILES) {
    if (updateJsonFile(file, newVersion)) count++;
  }

  console.log('\nPackages:');
  for (const file of PACKAGE_FILES) {
    if (updateJsonFile(file, newVersion)) count++;
  }

  console.log(`\nUpdated ${count} file(s).`);

  if (count > 0) {
    console.log(`\nNext: git commit -am "chore: bump to ${newVersion}" && git tag v${newVersion}`);
  }
}

main();
