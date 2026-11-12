import { execSync } from 'node:child_process';

export interface Commit {
  hash: string;
  shortHash: string;
  date: Date;
}

function readLastCommit(): Commit | null {
  try {
    const [hash, shortHash, date] = execSync('git log -1 --format=%H%n%h%n%cI', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split('\n');
    return { hash, shortHash, date: new Date(date) };
  } catch {
    return null;
  }
}

/** The commit the site was built from; `null` when git is not available. */
export const lastCommit = readLastCommit();
