import path from "node:path";
import { verifyBackup } from "./backup-verification.mjs";

const destination = process.argv.find((value) => value.startsWith("--from="))?.slice(7);
if (!destination) throw new Error("Choose a backup: npm run backup:verify -- --from=/absolute/path/to/backup-folder");
const report = await verifyBackup(path.resolve(destination));
console.log(`Recovery verified: ${report.files} files${report.database ? `, database schema ${report.database.schema}` : ""}. Live data was not changed.`);
