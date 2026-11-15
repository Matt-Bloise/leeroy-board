// Runs at the START of the api job, before any other test reads the preview. If an earlier crawl run was cancelled after it hid the admin member's sheet lines, this puts the member
// back (planted lines emptied, every line visible). With no planted marker it writes nothing. Refuses anything that does not say isPrPreview:true and api.leeroy.party / leeroy.party.
// Env: PREVIEW_API (Worker origin), BOARD_ADMIN_TOKEN (never printed). The logic is recoverTarget in tests/helpers/preview-crawl.mjs.
import { recoverTarget, assertIsPreview, assertPreviewBase } from "../helpers/preview-crawl.mjs";

const need = (n) => { const v = process.env[n]; if (!v) throw new Error(`${n} is not set`); return v.trim(); };
const API = need("PREVIEW_API").replace(/\/+$/, "");
const TOKEN = need("BOARD_ADMIN_TOKEN");
assertPreviewBase(API);
const call = async (method, path, { headers = {}, body } = {}) => {
  const init = { method, headers: { ...headers }, redirect: "manual" };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
  const res = await fetch(`${API}${path}`, init);
  return { status: res.status, text: await res.text(), headers: [...res.headers] };
};
await assertIsPreview(call);
const { recovered } = await recoverTarget({ adminCall: (m, p, b) => call(m, p, { headers: { Authorization: `Bearer ${TOKEN}` }, body: b }), say: (s) => process.stdout.write(`${s}\n`) });
process.stdout.write(recovered ? "recover-preview: the admin member was restored\n" : "recover-preview: nothing to restore\n");
