// For Claude, during a merge: `node <this file> <file>...` lists the lines either side added that the working tree
// lacks, and the lines it has more often than either side (see src/lines.ts).
import { Git } from "../src/git.ts";
import { checkLines, describeFindings } from "../src/lines.ts";

const git = new Git(process.cwd(), null);
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node check-lines.ts <file>...");
  process.exit(2);
}
const branch = process.env.CHUSAI_DEFAULT_BRANCH ?? "main";
console.log(describeFindings(await checkLines(git, files), branch, 200));
