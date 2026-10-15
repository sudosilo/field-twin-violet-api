// Field Twin Violet v3
// Reads `railway list --json` on stdin and prints the id of the project holding the named service.
// Usage: railway list --json | node field-twin-violet-v3-find-project.mjs fieldtwin-api
const want = process.argv[2];
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  const projects = Array.isArray(data) ? data : data.projects || (data.data && data.data.projects) || [];
  const list = Array.isArray(projects) ? projects : (projects.edges || []).map((e) => e.node);
  for (const p of list) {
    const node = p && p.node ? p.node : p;
    if (!node || !node.id) continue;
    if (JSON.stringify(node).includes(`"name":"${want}"`)) {
      process.stdout.write(node.id);
      return;
    }
  }
});
