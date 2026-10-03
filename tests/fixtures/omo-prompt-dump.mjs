import { writeFileSync } from "node:fs";

export default function (pi) {
  const dump = process.env.OAR_OMO_PROMPT_DUMP;
  pi.on("before_agent_start", (event) => {
    if (event?.preview) return;
    if (!dump) {
      process.exit(0);
      return;
    }
    writeFileSync(dump, String(event?.prompt ?? ""), { encoding: "utf8" });
    process.exit(0);
  });
}
