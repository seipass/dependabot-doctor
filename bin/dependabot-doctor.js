#!/usr/bin/env node
// Entry point for `npx dependabot-doctor` and for the checked-in git install.
import { main } from '../cli/cli.js';

process.exitCode = main(process.argv.slice(2));
