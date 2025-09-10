/**
 * Cloudflare Worker - AfterClass API
 * - dev: npm run dev
 * - deploy: npm run deploy
 *
 * Bindings in wrangler.jsonc:
 *  - DB (D1)
 *  - KV or AFTERCLASS_KV (KV)
 *  - ALLOW_ORIGIN
 *  - OPENAI_API_KEY (secret)
 *  - API_BEARER (secret, optional)
 */

type WorkerHandler = {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response;
};

export interface Env {
  DB: D1Database;
  AFTERCLASS_KV?: KVNamespace;
  KV: KVNamespace;
  ALLOW_ORIGIN: string;        // e.g. "https://foo.pages.dev, http://localhost:5173"
  OPENAI_API_KEY?: string;     // wrangler secret put OPENAI_API_KEY
  API_BEARER?: string;         // wrangler secret put API_BEARER (optional)
}

/* ----------------------- Helpers ----------------------- */
const nvl = <T,>(v: T): T | null => (v === undefined ? null : v);

function pickOrigin(allowList: string, reqOrigin: string | null): string {
  if (!allowList) return "*";
  const list = allowList.split(",").map(s => s.trim()).filter(Boolean);
  if (!reqOrigin) return list[0] || "*";
  return list.includes(reqOrigin) ? reqOrigin : list[0] || "*";
}

const corsHeaders = (o: string) => ({
  "Access-Control-Allow-Origin": o,
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
});

const j = (data: unknown, status = 200, o = "*") =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(o) }
  });

const no = (o: string) => new Response(null, { status: 204, headers: corsHeaders(o) });

function bearerOk(req: Request, env: Env): boolean {
//   if (!env.API_BEARER) return true; // if no bearer configured, skip auth
//   const auth = req.headers.get("Authorization") || "";
//   return auth === `Bearer ${env.API_BEARER}`;
	return true;
}

/** super-simple KV rate limit: N reqs per ttlSec per key */
async function rateLimit(env: Env, key: string, limit = 60, ttlSec = 60): Promise<boolean> {
  const kv = env.AFTERCLASS_KV ?? env.KV;
  if (!kv) return true; // no KV, skip ratelimit
  const bucket = `rl:${key}:${Math.floor(Date.now() / (ttlSec * 1000))}`;
  const v = await kv.get(bucket);
  const n = v ? parseInt(v, 10) : 0;
  if (n >= limit) return false;
  await kv.put(bucket, String(n + 1), { expirationTtl: ttlSec + 5 });
  return true;
}

/* ----------------------- Answer types & grading ----------------------- */
type Answer =
  | { kind: "single"; index: number }
  | { kind: "multiple"; indices: number[] }
  | { kind: "numeric"; value: string; tolerance?: string }
  | { kind: "text"; accept: string[] }
  | { kind: "cloze"; blanks: string[] }
  | { kind: "ordering"; order: number[] }
  | { kind: "matching"; pairs: [string, string][] }
  | { kind: "tablefill"; cells: string[][] };

function normStr(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

function eqNumeric(a: string, b: string, tol = 0): boolean {
  const toNum = (x: string) => {
    const t = x.trim();
    if (/^\d+\/\d+$/.test(t)) {
      const [p, q] = t.split("/").map(Number);
      return q === 0 ? NaN : p / q;
    }
    return Number(t);
  };
  const na = toNum(a), nb = toNum(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return false;
  return Math.abs(na - nb) <= tol;
}

/** return 0/1 */
function grade(raw: any, correctAns: Answer): number {
  try {
    switch (correctAns.kind) {
      case "single":
        return raw && raw.kind === "single" && raw.index === correctAns.index ? 1 : 0;
      case "multiple": {
        const a = Array.isArray(raw?.indices) ? [...raw.indices].sort() : [];
        const b = [...correctAns.indices].sort();
        return JSON.stringify(a) === JSON.stringify(b) ? 1 : 0;
      }
      case "numeric": {
        const tol = correctAns.tolerance ? Number(correctAns.tolerance) : 0;
        return raw && typeof raw.value === "string" && eqNumeric(raw.value, (correctAns as any).value, tol) ? 1 : 0;
      }
      case "text": {
        const cand = typeof raw?.text === "string" ? raw.text : (Array.isArray(raw?.accept) ? raw.accept[0] : "");
        const norm = normStr(String(cand || ""));
        return (correctAns.accept || []).some(acc => normStr(acc) === norm) ? 1 : 0;
      }
      case "cloze": {
        const arr = Array.isArray(raw?.blanks) ? raw.blanks : [];
        if (arr.length !== correctAns.blanks.length) return 0;
        for (let i = 0; i < arr.length; i++) {
          if (normStr(String(arr[i])) !== normStr(String(correctAns.blanks[i]))) return 0;
        }
        return 1;
      }
      case "ordering": {
        const arr = Array.isArray(raw?.order) ? raw.order : [];
        return JSON.stringify(arr) === JSON.stringify(correctAns.order) ? 1 : 0;
      }
      case "matching": {
        const pairs = Array.isArray(raw?.pairs) ? raw.pairs : [];
        const norm = (p: [string, string]) => `${normStr(p[0])}=>${normStr(p[1])}`;
        const a = pairs.map(norm).sort();
        const b = correctAns.pairs.map(norm).sort();
        return JSON.stringify(a) === JSON.stringify(b) ? 1 : 0;
      }
      case "tablefill": {
        const cells = Array.isArray(raw?.cells) ? raw.cells : [];
        if (cells.length !== correctAns.cells.length) return 0;
        for (let i = 0; i < cells.length; i++) {
          const rowA = cells[i] || [], rowB = correctAns.cells[i] || [];
          if (rowA.length !== rowB.length) return 0;
          for (let j = 0; j < rowA.length; j++) {
            if (normStr(String(rowA[j])) !== normStr(String(rowB[j]))) return 0;
          }
        }
        return 1;
      }
    }
  } catch {}
  return 0;
}

/* ----------------------- GPT helper for process eval ----------------------- */
async function gptEvaluate(env: Env, prompt: string, preferStrong = false, maxTokens = 500) {
  if (!env.OPENAI_API_KEY) {
    return {
      model: "none",
      text: JSON.stringify({
        verdict: "uncertain",
        reasoning: "OPENAI_API_KEY 未設定，返回示意結果。",
        rubric: { setup: 0, operations: 0, units: 0, presentation: 0 },
        confidence: 0
      })
    };
  }
  const tryModels = preferStrong ? ["gpt-4o"] : ["gpt-4o-mini", "gpt-4o"];
  let last = "";
  for (const model of tryModels) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "你是國中數學助教。用 JSON 回答：{verdict:'correct|incorrect|uncertain', reasoning:string, rubric:{setup,operations,units,presentation}, confidence:number}" },
          { role: "user", content: prompt }
        ],
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: { type: "json_object" }
      })
    });
    const data = await r.json();
    last = data?.choices?.[0]?.message?.content ?? "";
    try {
      const o = JSON.parse(last);
      if (o.verdict !== "uncertain" && (o.confidence ?? 0.5) >= 0.6) {
        return { model, text: last };
      }
    } catch {
      // escalate
    }
  }
  return {
    model: preferStrong ? "gpt-4o" : "gpt-4o-mini",
    text: last || JSON.stringify({ verdict: "uncertain", reasoning: "模型未返回有效 JSON", confidence: 0 })
  };
}

/* ----------------------- DB bootstrap (ensure tables) ----------------------- */
async function ensureExtraTables(env: Env) {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS item_issues (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        user_id TEXT,
        session_id TEXT,
        ts TEXT NOT NULL,
        reason TEXT NOT NULL,
        note TEXT,
        raw_answer TEXT,
        correct INTEGER
      )
    `),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_item_issues_item_ts ON item_issues(item_id, ts DESC)`),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS item_revisions (
        rev_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        editor TEXT,
        before_json TEXT NOT NULL,
        after_json  TEXT NOT NULL
      )
    `),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_item_revisions_item_ts ON item_revisions(item_id, ts DESC)`)
  ]);
}

/* ----------------------- Suspicious quarantine helpers ----------------------- */
const QUARANTINE_N = 30;
const QUARANTINE_MIN_N = 20;
const QUARANTINE_RATE = 0.10;   // < 10%
const QUARANTINE_ISSUES_24H = 3;

async function getItemRecentStats(env: Env, item_id: string) {
  // last N attempts
  const attempts = await env.DB.prepare(`
    SELECT correct FROM attempts
    WHERE item_id=?
    ORDER BY ts DESC
    LIMIT ?
  `).bind(item_id, QUARANTINE_N).all<any>();

  const arr = (attempts.results as any[]).map(r => Number(r.correct ? 1 : 0));
  const n = arr.length;
  const correct = arr.reduce((a, b) => a + b, 0);
  const rate = n ? correct / n : 0;

  // issues in last 24h
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const issues = await env.DB.prepare(`
    SELECT COUNT(*) AS c FROM item_issues
    WHERE item_id=? AND ts>=?
  `).bind(item_id, since).first<any>();
  const issues24h = Number(issues?.c ?? 0);

  return { n, rate, issues24h };
}

async function checkAndQuarantineItem(env: Env, item_id: string) {
  const { n, rate, issues24h } = await getItemRecentStats(env, item_id);
  if ((n >= QUARANTINE_MIN_N && rate < QUARANTINE_RATE) || (issues24h >= QUARANTINE_ISSUES_24H)) {
    await env.DB.prepare(`UPDATE items SET status='needs_review' WHERE id=? AND status!='retired'`).bind(item_id).run();
    return { quarantined: true, n, rate, issues24h };
  }
  return { quarantined: false, n, rate, issues24h };
}

/* ----------------------- Main router ----------------------- */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = pickOrigin(env.ALLOW_ORIGIN, req.headers.get("Origin"));
    try {
      // 確保新增表存在（惰性建立）
      await ensureExtraTables(env);

      const url = new URL(req.url);

      if (req.method === "OPTIONS") return no(origin);

      // health
      if (url.pathname === "/api/health" && req.method === "GET") {
        return j({ ok: true, time: new Date().toISOString() }, 200, origin);
      }

      // GET /api/items
      if (url.pathname === "/api/items" && req.method === "GET") {
        try {
          const subject = url.searchParams.get("subject");
          const unit = url.searchParams.get("unit");
          const kc = url.searchParams.get("kc");
          const q = url.searchParams.get("q");
          const n = Math.max(1, Math.min(50, Number(url.searchParams.get("n") || 10)));
          const page = Math.max(1, Number(url.searchParams.get("page") || 1));
          const random = url.searchParams.get("random") === "1";
          const includeAns = url.searchParams.get("include_answer") === "1";
          const authed = bearerOk(req, env);

          let sql = `SELECT * FROM items WHERE status='published'`;
          const params: any[] = [];
          if (subject) { sql += ` AND subject=?`; params.push(subject); }
          if (unit)    { sql += ` AND unit=?`;    params.push(unit); }
          if (kc)      { sql += ` AND kcs LIKE ?`;params.push(`%${kc}%`); }
          if (q)       { sql += ` AND (stem LIKE ? OR solution LIKE ?)`; params.push(`%${q}%`,`%${q}%`); }
          sql += random ? ` ORDER BY random()` : ` ORDER BY created_at DESC`;
          sql += ` LIMIT ? OFFSET ?`; params.push(n, (page - 1) * n);

          const { results } = await env.DB.prepare(sql).bind(...params).all();
          const data = (results as any[]).map(r => {
            const base: any = {
              id: r.id, subject: r.subject, grade: r.grade, unit: r.unit,
              kcs: r.kcs ? String(r.kcs).split("|") : [],
              item_type: r.item_type, difficulty: r.difficulty,
              stem: r.stem,
              choices: r.choices ? JSON.parse(r.choices) : null,
              solution: r.solution,
              tags: r.tags ? String(r.tags).split("|") : [],
              source: r.source, status: r.status
            };
            if (includeAns && authed) base.answer = r.answer ? JSON.parse(r.answer) : null;
            return base;
          });
          return j({ page, count: data.length, items: data }, 200, origin);
        } catch (e: any) {
          return j({ error: "items_query_failed", detail: String(e?.message || e) }, 500, origin);
        }
      }

      // GET /api/items/:id
      if (url.pathname.startsWith("/api/items/") && req.method === "GET") {
        try {
          const id = url.pathname.split("/").pop()!;
          const includeAns = url.searchParams.get("include_answer") === "1";
          const authed  = bearerOk(req, env);
          const row = await env.DB.prepare(`SELECT * FROM items WHERE id=?`).bind(id).first<any>();
          if (!row) return j({ error: "not_found" }, 404, origin);
          const base: any = {
            id: row.id, subject: row.subject, grade: row.grade, unit: row.unit,
            kcs: row.kcs ? String(row.kcs).split("|") : [],
            item_type: row.item_type, difficulty: row.difficulty,
            stem: row.stem,
            choices: row.choices ? JSON.parse(row.choices) : null,
            solution: row.solution,
            tags: row.tags ? String(row.tags).split("|") : [],
            source: row.source, status: row.status
          };
          if (includeAns && authed) base.answer = row.answer ? JSON.parse(row.answer) : null;
          return j(base, 200, origin);
        } catch (e: any) {
          return j({ error: "item_fetch_failed", detail: String(e?.message || e) }, 500, origin);
        }
      }

      // POST /api/grade   (check correctness without leaking official answer)
      if (url.pathname === "/api/grade" && req.method === "POST") {
        if (!bearerOk(req, env)) return j({ error: "unauthorized" }, 401, origin);
        try {
          const body = await req.json().catch(() => ({}));
          const item_id = String(body.item_id ?? "");
          const raw_answer = body.raw_answer ?? null;
          if (!item_id) return j({ error: "missing_item_id" }, 400, origin);

          const row = await env.DB
            .prepare(`SELECT answer FROM items WHERE id=? AND status='published'`)
            .bind(item_id)
            .first<any>();
          if (!row?.answer) return j({ error: "answer_not_available" }, 404, origin);

          const correctAns: Answer = JSON.parse(row.answer);
          const isRight = grade(raw_answer, correctAns) ? 1 : 0;

          return j({ item_id, correct: isRight }, 200, origin);
        } catch (e: any) {
          return j({ error: "grade_failed", detail: String(e?.message || e) }, 500, origin);
        }
      }

      /* ---------- POST /api/ingest/vision (OpenAI Vision) ---------- */
      if (url.pathname === "/api/ingest/vision" && req.method === "POST") {
        // 若要完全開放，改成：不檢查 bearerOk
        if (!bearerOk(req, env)) return j({ error: "unauthorized" }, 401, origin);

        try {
          const start = Date.now();
          const body = await req.json().catch(() => ({}));
          const dataUrl: string = String(body.image_data_url || "");
          const subject: string = String(body.subject || "math");
          const grade: string = String(body.grade || "g7");
          const unit: string = String(body.unit || "unsorted");
          const preferStrong = url.searchParams.get("strong") === "1";

          if (!env.OPENAI_API_KEY) {
            return j({ error: "no_openai_key" }, 500, origin);
          }
          if (!dataUrl.startsWith("data:image/")) {
            return j({ error: "bad_image_data_url", hint: "請傳 data:image/png;base64,..." }, 400, origin);
          }

          // Prompt：要求輸出 { items: [...] }
          const sys =
`你是國中數學題目擷取器。從圖片擷取「最多 10 題」獨立題目，輸出 JSON 物件：
{
  "items": [
    {
      "id": string,
      "subject": "math",
      "grade": "g7"|"g8"|"g9",
      "unit": string,
      "item_type": "single"|"multiple"|"truefalse"|"numeric"|"text"|"cloze"|"ordering"|"matching"|"tablefill",
      "difficulty": 1|2|3,
      "stem": string,
      "choices": string[] | null,
      "answer": any | null,
      "solution": string | null,
      "kcs": string[],
      "tags": string[]
    }
  ]
}
規則：
- 單選：item_type="single"，choices 為字串陣列，answer = {"kind":"single","index":0-based}
- 多選：item_type="multiple"，answer={"kind":"multiple","indices":[...]}
- 判斷：item_type="truefalse"，choices=["對","錯"]，answer={"kind":"single","index":0或1}
- 數值：item_type="numeric"，answer={"kind":"numeric","value":"字串，可分數/小數"}
- 文字：item_type="text"，answer={"kind":"text","accept":["答案1","答案2"]}
- 填空：item_type="cloze"，answer={"kind":"cloze","blanks":["依序空格答案"]}
- 配對：item_type="matching"，answer={"kind":"matching","pairs":[["左","右"],...]}
- 排序：item_type="ordering"，answer={"kind":"ordering","order":[整數索引順序]}
- 表格填空：item_type="tablefill"，answer={"kind":"tablefill","cells":[["r1c1","r1c2"],...]}
- 若題目沒有標準答案可可靠推斷，answer=null；
- 請勿在 stem 出現裁切殘字；解析度不足就保守略過該題。
- 僅輸出 JSON，不要多餘文字。`;

          const userText =
`科目=${subject}，年級=${grade}，單元=${unit}。
請從下圖擷取題目為 JSON（最多 10 題）。`;

		async function callVision(env: Env, model: string, dataUrl: string, userText: string, sys: string) {
		const r = await fetch("https://api.openai.com/v1/chat/completions", {
			method: "POST",
			headers: {
			"Authorization": `Bearer ${env.OPENAI_API_KEY}`,
			"Content-Type": "application/json"
			},
			body: JSON.stringify({
			model,
			temperature: 0.0,
			response_format: { type: "json_object" },
			messages: [
				{ role: "system", content: sys },
				{
				role: "user",
				content: [
					{ type: "text", text: userText },
					{ type: "image_url", image_url: { url: dataUrl } }
				]
				}
			]
			})
		});

		let payload: any = null;
		try { payload = await r.json(); } catch { payload = null; }

		const ok = r.ok && payload?.choices?.[0]?.message?.content;
		return {
			ok,
			status: r.status,
			payload,
			raw: ok ? payload.choices[0].message.content : "",
			usage: payload?.usage || null,
			error: !ok ? (payload?.error || { message: "unknown_error" }) : null
		};
		}
    
    // 先 mini，再視情況升級 4o
    const firstModel = preferStrong ? "gpt-4o" : "gpt-4o-mini";

		  let out = await callVision(env, firstModel, dataUrl, userText, sys);
		  if (!out.ok) {
			  const fallback = await callVision(env, "gpt-4o", dataUrl, userText, sys);
			  // 若 fallback OK 就用 fallback；否則仍用第一次但帶出錯誤
			  if (fallback.ok) out = fallback; else out = { ...out, model: firstModel, fallback_error: fallback.error, fallback_status: fallback.status };
		  }


          let parsed: any = {};
          try { parsed = JSON.parse(out.raw); } catch { parsed = {}; }
          let items = Array.isArray(parsed?.items) ? parsed.items : [];

          // 後處理：補齊 subject/grade/unit、限制長度、確保欄位型別
          items = items
            .map((it: any) => ({
              id: it?.id ?? crypto.randomUUID(),
              subject,
              grade,
              unit,
              item_type: String(it?.item_type ?? "single"),
              difficulty: Number(it?.difficulty ?? 2),
              stem: String(it?.stem ?? "").slice(0, 4000),
              choices: it?.choices ?? null,
              answer: it?.answer ?? null,
              solution: typeof it?.solution === "string" ? it.solution : "",
              kcs: Array.isArray(it?.kcs) ? it.kcs : [],
              tags: Array.isArray(it?.tags) ? it.tags : []
            }))
            .filter((it: any) => it.stem);

          return j({
            count: items.length,
            items,
            model: firstModel,
            usage: out.usage ?? null,
            raw: out.raw,                 // 方便前端「顯示模型原始回應」
			      oai_status: out.status,
            oai_error: out.error || null,
            fallback_status: (out as any).fallback_status || null,
            fallback_error: (out as any).fallback_error || null,
            duration_ms: Date.now() - start
          }, 200, origin);
        } catch (e: any) {
          return j({ error: "ingest_failed", detail: String(e?.message || e) }, 500, origin);
        }
      }

      // POST /api/items/upsert  (bulk upsert)
      if (url.pathname === "/api/items/upsert" && req.method === "POST") {
        if (!bearerOk(req, env)) return j({ error: "unauthorized" }, 401, origin);
        try {
          const body = await req.json().catch(() => ({}));
          const items = Array.isArray(body.items) ? body.items : [];
          if (!items.length) return j({ upserted: 0 }, 200, origin);

          let upserted = 0;
          for (const it of items) {
            const id = String(it.id || crypto.randomUUID());
            const subject = String(it.subject || "math");
            const grade = String(it.grade || "g7");
            const unit = String(it.unit || "unsorted");
            const item_type = String(it.item_type || "text");
            const stem = String(it.stem || "");
            const choicesJson = it.choices != null ? JSON.stringify(it.choices) : null;
            const answerJson  = it.answer  != null ? JSON.stringify(it.answer)  : null;
            const solution = String(it.solution || "");
            const difficulty = Number(it.difficulty ?? 2);
            const kcs = Array.isArray(it.kcs) ? it.kcs.join("|") : "";
            const tags = Array.isArray(it.tags) ? it.tags.join("|") : "";
            const source = String(it.source || "ingest");
            const status = String(it.status || "published");

            const ins = await env.DB.prepare(`
              INSERT INTO items
              (id, subject, grade, unit, item_type, stem, choices, answer, solution, difficulty, kcs, tags, source, status, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
              ON CONFLICT(id) DO UPDATE SET
                subject=excluded.subject, grade=excluded.grade, unit=excluded.unit,
                item_type=excluded.item_type, stem=excluded.stem,
                choices=excluded.choices, answer=excluded.answer, solution=excluded.solution,
                difficulty=excluded.difficulty, kcs=excluded.kcs, tags=excluded.tags,
                source=excluded.source, status=excluded.status
                updated_at=datetime('now')
            `).bind(
              id, subject, grade, unit, item_type, stem, choicesJson, answerJson, solution,
              difficulty, kcs, tags, source, status
            ).run();

            if (ins.success) upserted++;
          }
          return j({ upserted }, 200, origin);
        } catch (e: any) {
          return j({ error: "upsert_failed", detail: String(e?.message || e) }, 500, origin);
        }
      }

	/* ----------------------- Backup ----------------------- */
	async function backupToKV(env: Env, scope: "items"|"all" = "items") {
		const kv = env.AFTERCLASS_KV ?? env.KV;
		if (!kv) throw new Error("KV not bound");

		const out: any = {
			schema: "afterclass-backup.v1",
			scope,
			created_at: new Date().toISOString(),
			items: [] as any[],
		};

		// items
		{
			const { results } = await env.DB.prepare(
			`SELECT id,subject,grade,unit,item_type,stem,choices,answer,solution,difficulty,kcs,tags,source,status,created_at,updated_at
			FROM items`
			).all();
			out.items = (results as any[]).map(r => ({
			id: r.id,
			subject: r.subject,
			grade: r.grade,
			unit: r.unit,
			item_type: r.item_type,
			stem: r.stem,
			choices: r.choices ? JSON.parse(r.choices) : null,
			answer:  r.answer  ? JSON.parse(r.answer)  : null,
			solution: r.solution,
			difficulty: r.difficulty,
			kcs: r.kcs ? String(r.kcs).split("|") : [],
			tags: r.tags ? String(r.tags).split("|") : [],
			source: r.source,
			status: r.status,
			created_at: r.created_at,
			updated_at: r.updated_at
			}));
		}

		if (scope === "all") {
			// attempts
			const { results: attempts } = await env.DB.prepare(
			`SELECT attempt_id,user_id,item_id,ts,elapsed_sec,raw_answer,correct,attempts,work_url,process_json,rubric_json,eval_model,device_id,session_id
			FROM attempts`
			).all();
			out.attempts = (attempts as any[]).map(r => ({
			attempt_id: r.attempt_id,
			user_id: r.user_id,
			item_id: r.item_id,
			ts: r.ts,
			elapsed_sec: r.elapsed_sec,
			raw_answer: r.raw_answer ? JSON.parse(r.raw_answer) : null,
			correct: r.correct,
			attempts: r.attempts,
			work_url: r.work_url,
			process_json: r.process_json ? JSON.parse(r.process_json) : null,
			rubric_json: r.rubric_json ? JSON.parse(r.rubric_json) : null,
			eval_model: r.eval_model,
			device_id: r.device_id,
			session_id: r.session_id
			}));

			// kc_stats
			const { results: stats } = await env.DB.prepare(
			`SELECT user_id,kc,w,correct_rate,total_attempts,correct_attempts,streak,last_ts FROM kc_stats`
			).all();
			out.kc_stats = stats;
		}

		const key = "backup:items:latest";
		const text = JSON.stringify(out);
		await kv.put(key, text, { expirationTtl: 60 * 60 * 24 * 30 }); // 保存 30 天（可調整）

		return { key, bytes: text.length, counts: {
			items: out.items.length,
			attempts: Array.isArray(out.attempts) ? out.attempts.length : 0,
			kc_stats: Array.isArray(out.kc_stats) ? out.kc_stats.length : 0
		}};
	}

	/* ---------- 管理端：手動備份 ---------- */
	if (url.pathname === "/api/admin/backup" && req.method === "POST") {
		if (!bearerOk(req, env)) return j({ error: "unauthorized" }, 401, origin);
		try {
			const body = await req.json().catch(()=>({}));
			const scope: "items"|"all" = body.scope === "all" ? "all" : "items";
			const res = await backupToKV(env, scope);
			return j({ ok: true, scope, key: res.key, counts: res.counts, bytes: res.bytes }, 200, origin);
		} catch (e:any) {
			return j({ error: "backup_failed", detail: String(e?.message || e) }, 500, origin);
		}
	}

	/* ---------- 管理端：下載最新備份 ---------- */
	if (url.pathname === "/api/admin/backup/latest" && req.method === "GET") {
		if (!bearerOk(req, env)) return j({ error: "unauthorized" }, 401, origin);
		try {
			const kv = env.AFTERCLASS_KV ?? env.KV;
			if (!kv) return j({ error: "no_kv_binding" }, 500, origin);
			const text = await kv.get("backup:items:latest");
			if (!text) return j({ error: "not_found" }, 404, origin);
			return new Response(text, {
			status: 200,
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"Content-Disposition": `attachment; filename="afterclass-backup-latest.json"`,
				...corsHeaders(origin)
			}
			});
		} catch (e:any) {
			return j({ error: "backup_download_failed", detail: String(e?.message || e) }, 500, origin);
		}
	}

	/* ---------- 管理端：清空題庫（先自動備份） ---------- */
	if (url.pathname === "/api/admin/purge" && req.method === "POST") {
		if (!bearerOk(req, env)) return j({ error: "unauthorized" }, 401, origin);
		try {
			const body = await req.json().catch(() => ({}));
			const today = new Date().toISOString().slice(0, 10);
			if (body.confirm !== today) {
				return j({ error: "confirm_required", hint: today }, 400, origin);
			}

			// 先備份（只保留一份最新）
			const backup = await backupToKV(env, body.scope === "all" ? "all" : "items");

			// 再清空
			await env.DB.prepare("DELETE FROM attempts").run();
			await env.DB.prepare("DELETE FROM kc_stats").run();
			await env.DB.prepare("DELETE FROM items").run();

			return j({ ok: true, backup, cleared: ["items", "attempts", "kc_stats"] }, 200, origin);
		} catch (e: any) {
			return j({ error: "purge_failed", detail: String(e?.message || e) }, 500, origin);
		}
	}

    /* ----------------------- NEW: Issue reporting & review queue ----------------------- */

    // POST /api/items/issues  —— 學生/監考回報題目有問題
    if (url.pathname === "/api/items/issues" && req.method === "POST") {
      // 視需求放寬驗證。此處沿用 bearerOk。
      if (!bearerOk(req, env)) return j({ error: "unauthorized" }, 401, origin);
      try {
        const body = await req.json().catch(()=> ({}));
        const id = crypto.randomUUID();
        const item_id = String(body.item_id || "");
        const reason = String(body.reason || "other");
        const note = nvl(body.note != null ? String(body.note) : null);
        const raw_answer = nvl(body.raw_answer != null ? JSON.stringify(body.raw_answer) : null);
        const correct = Number(body.correct ?? null);
        const user_id = nvl(body.user_id != null ? String(body.user_id) : null);
        const session_id = nvl(body.session_id != null ? String(body.session_id) : null);
        const ts = new Date().toISOString();

        if (!item_id) return j({ error: "missing_item_id" }, 400, origin);

        await env.DB.prepare(`
          INSERT INTO item_issues (id, item_id, user_id, session_id, ts, reason, note, raw_answer, correct)
          VALUES (?,?,?,?,?,?,?,?,?)
        `).bind(id, item_id, user_id, session_id, ts, reason, note, raw_answer, isFinite(correct) ? correct : null).run();

        // 回報累積檢查：若過多則 quarantine
        await checkAndQuarantineItem(env, item_id);

        return j({ ok: true, id }, 200, origin);
      } catch (e:any) {
        return j({ error: "issue_create_failed", detail: String(e?.message || e) }, 500, origin);
      }
    }

    // GET /api/admin/items/issues?item_id=...&since=...&limit=50
    if (url.pathname === "/api/admin/items/issues" && req.method === "GET") {
      if (!bearerOk(req, env)) return j({ error: "unauthorized" }, 401, origin);
      try {
        const item_id = String(url.searchParams.get("item_id") || "");
        if (!item_id) return j({ error: "missing_item_id" }, 400, origin);
        const since = url.searchParams.get("since") || "1970-01-01T00:00:00.000Z";
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 50)));

        const { results } = await env.DB.prepare(`
          SELECT id, item_id, user_id, session_id, ts, reason, note, raw_answer, correct
          FROM item_issues
          WHERE item_id=? AND ts>=?
          ORDER BY ts DESC
          LIMIT ?
        `).bind(item_id, since, limit).all();

        const rows = (results as any[]).map(r => ({
          id: r.id,
          item_id: r.item_id,
          user_id: r.user_id,
          session_id: r.session_id,
          ts: r.ts,
          reason: r.reason,
          note: r.note,
          raw_answer: r.raw_answer ? JSON.parse(r.raw_answer) : null,
          correct: (r.correct == null ? null : Number(r.correct))
        }));

        return j({ count: rows.length, issues: rows }, 200, origin);
      } catch (e:any) {
        return j({ error: "issues_fetch_failed", detail: String(e?.message || e) }, 500, origin);
      }
    }

      // GET /api/admin/items/review-queue?limit=50
      if (url.pathname === "/api/admin/items/review-queue" && req.method === "GET") {
        if (!bearerOk(req, env)) return j({ error: "unauthorized" }, 401, origin);
        try {
          const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 50)));
          const { results } = await env.DB.prepare(`
            SELECT * FROM items WHERE status='needs_review'
            ORDER BY updated_at DESC NULLS LAST, created_at DESC
            LIMIT ?
          `).bind(limit).all();

          const items = [];
          for (const r of (results as any[])) {
            const item_id = r.id;
            const base: any = {
              id: r.id, subject: r.subject, grade: r.grade, unit: r.unit,
              kcs: r.kcs ? String(r.kcs).split("|") : [],
              item_type: r.item_type, difficulty: r.difficulty,
              stem: r.stem,
              choices: r.choices ? JSON.parse(r.choices) : null,
              solution: r.solution,
              tags: r.tags ? String(r.tags).split("|") : [],
              source: r.source, status: r.status
            };

            const { n, rate, issues24h } = await getItemRecentStats(env, item_id);

            // 取最近 3 筆回報
            const lastIssues = await env.DB.prepare(`
              SELECT id, ts, reason, note, correct
              FROM item_issues
              WHERE item_id=?
              ORDER BY ts DESC
              LIMIT 3
            `).bind(item_id).all<any>();

            items.push({
              item: base,
              stats: { recent_n: n, recent_correct_rate: rate, issues_24h: issues24h },
              last_issues: (lastIssues.results as any[]).map(ir => ({
                id: ir.id, ts: ir.ts, reason: ir.reason, note: ir.note, correct: ir.correct
              }))
            });
          }

          return j({ count: items.length, items }, 200, origin);
        } catch (e:any) {
          return j({ error: "review_queue_failed", detail: String(e?.message || e) }, 500, origin);
        }
      }

      // PUT /api/items/:id —— 管理端修訂題目（寫入 item_revisions）
      if (url.pathname.startsWith("/api/items/") && req.method === "PUT") {
        if (!bearerOk(req, env)) return j({ error: "unauthorized" }, 401, origin);
        try {
          const id = url.pathname.split("/").pop()!;
          const patch = await req.json().catch(()=> ({}));

          // 取舊
          const oldRow = await env.DB.prepare(`SELECT * FROM items WHERE id=?`).bind(id).first<any>();
          if (!oldRow) return j({ error: "not_found" }, 404, origin);

          const before = {
            id: oldRow.id,
            subject: oldRow.subject, grade: oldRow.grade, unit: oldRow.unit,
            item_type: oldRow.item_type, difficulty: oldRow.difficulty,
            stem: oldRow.stem,
            choices: oldRow.choices ? JSON.parse(oldRow.choices) : null,
            answer:  oldRow.answer  ? JSON.parse(oldRow.answer)  : null,
            solution: oldRow.solution,
            kcs: oldRow.kcs ? String(oldRow.kcs).split("|") : [],
            tags: oldRow.tags ? String(oldRow.tags).split("|") : [],
            source: oldRow.source, status: oldRow.status
          };

          // 合併新值
          const subject = patch.subject ?? before.subject;
          const grade = patch.grade ?? before.grade;
          const unit = patch.unit ?? before.unit;
          const item_type = patch.item_type ?? before.item_type;
          const difficulty = Number(patch.difficulty ?? before.difficulty);
          const stem = patch.stem ?? before.stem;
          const choices = (patch.choices !== undefined) ? patch.choices : before.choices;
          const answer  = (patch.answer  !== undefined) ? patch.answer  : before.answer;
          const solution = patch.solution ?? before.solution;
          const kcsArr = Array.isArray(patch.kcs) ? patch.kcs : before.kcs;
          const tagsArr = Array.isArray(patch.tags) ? patch.tags : before.tags;
          const source = patch.source ?? before.source;
          const status = patch.status ?? before.status;

          if (!stem) return j({ error: "missing_stem" }, 400, origin);
          const allowed = ["single","multiple","numeric","text","cloze","ordering","matching","tablefill","truefalse"];
          if (!allowed.includes(item_type)) return j({ error: "bad_item_type" }, 400, origin);

          // 更新
          await env.DB.prepare(`
            UPDATE items SET
              subject=?, grade=?, unit=?, item_type=?, difficulty=?,
              stem=?, choices=?, answer=?, solution=?,
              kcs=?, tags=?, source=?, status=?, updated_at=CURRENT_TIMESTAMP
            WHERE id=?
          `).bind(
            subject, grade, unit, item_type, difficulty,
            String(stem), choices != null ? JSON.stringify(choices) : null,
            answer  != null ? JSON.stringify(answer)  : null,
            String(solution ?? ""),
            Array.isArray(kcsArr) ? kcsArr.join("|") : "",
            Array.isArray(tagsArr) ? tagsArr.join("|") : "",
            String(source ?? "manual"),
            String(status ?? "published"),
            id
          ).run();

          // 寫修訂
          const after = {
            id,
            subject, grade, unit, item_type, difficulty, stem, choices, answer, solution,
            kcs: Array.isArray(kcsArr) ? kcsArr : [],
            tags: Array.isArray(tagsArr) ? tagsArr : [],
            source, status
          };
          const rev_id = crypto.randomUUID();
          const editor = patch.editor ?? "admin";
          await env.DB.prepare(`
            INSERT INTO item_revisions (rev_id, item_id, ts, editor, before_json, after_json)
            VALUES (?,?,?,?,?,?)
          `).bind(
            rev_id, id, new Date().toISOString(), String(editor),
            JSON.stringify(before), JSON.stringify(after)
          ).run();

          return j({ ok: true, id, rev_id }, 200, origin);
        } catch (e:any) {
          return j({ error: "item_update_failed", detail: String(e?.message || e) }, 500, origin);
        }
      }    
	  
      /* ----------------------- Attempts bulk (with quarantine) ----------------------- */
      // POST /api/attempts/bulk
      if (url.pathname === "/api/attempts/bulk" && req.method === "POST") {
        if (!bearerOk(req, env)) return j({ error: "unauthorized" }, 401, origin);
        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        if (!(await rateLimit(env, `attempts:${ip}`, 180, 60))) return j({ error: "rate_limited" }, 429, origin);

        const DEBUG = true;
        try {
          const body = await req.json().catch(() => ({}));
          const attemptsIn = Array.isArray(body.attempts) ? body.attempts : [];
          if (!attemptsIn.length) return j({ inserted: 0, updated: 0, duplicates: 0, failures: [] }, 200, origin);
          if (attemptsIn.length > 200) return j({ error: "too_many_attempts", limit: 200 }, 400, origin);

          let inserted = 0, updated = 0, duplicates = 0;
          const failures: Array<{ i:number; reason:string }> = [];
          const touched = new Set<string>();

          for (let i = 0; i < attemptsIn.length; i++) {
            const a = attemptsIn[i];
            try {
              const attempt_id = String(a?.attempt_id ?? crypto.randomUUID());
              const user_id    = String(a?.user_id ?? "anon");
              const item_id    = String(a?.item_id ?? "");
              if (!item_id) throw new Error("missing_item_id");

              const ts         = String(a?.ts ?? new Date().toISOString());
              const elapsed    = Number(a?.elapsed_sec ?? 0);
              const attemptsN  = Number(a?.attempts ?? 1);
              const work_url   = nvl(a?.work_url ?? null);
              const process_json = nvl(a?.process_json != null ? JSON.stringify(a.process_json) : null);
              const rubric_json  = nvl(a?.rubric_json  != null ? JSON.stringify(a.rubric_json)  : null);
              const eval_model = nvl(a?.eval_model ?? null);
              const device_id  = nvl(a?.device_id ?? null);
              const session_id = nvl(a?.session_id ?? null);
              const raw_answer = nvl(a?.raw_answer != null ? JSON.stringify(a.raw_answer) : null);

              const itemRow = await env.DB
                .prepare(`SELECT id, answer, kcs FROM items WHERE id=?`)
                .bind(item_id).first<any>();

              const ans: Answer | null = itemRow?.answer ? JSON.parse(itemRow.answer) : null;
              const serverCorrect = ans ? grade(a?.raw_answer, ans) : 0;

              const ins = await env.DB.prepare(
                `INSERT OR IGNORE INTO attempts
                 (attempt_id,user_id,item_id,ts,elapsed_sec,raw_answer,correct,attempts,work_url,process_json,rubric_json,eval_model,device_id,session_id)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
              ).bind(
                attempt_id, user_id, item_id, ts, elapsed, raw_answer,
                Number(serverCorrect ?? 0), attemptsN, work_url, process_json, rubric_json,
                eval_model, device_id, session_id
              ).run();

              if (ins.success && ins.meta.changes === 1) {
                inserted++;
              } else {
                const upd = await env.DB.prepare(
                  `UPDATE attempts SET user_id=?, item_id=?, ts=?, elapsed_sec=?, raw_answer=?, correct=?, attempts=?,
                   work_url=?, process_json=?, rubric_json=?, eval_model=?, device_id=?, session_id=?
                   WHERE attempt_id=?`
                ).bind(
                  user_id, item_id, ts, elapsed, raw_answer,
                  Number(serverCorrect ?? 0), attemptsN, work_url, process_json, rubric_json,
                  eval_model, device_id, session_id, attempt_id
                ).run();
                if (upd.meta.changes === 1) updated++; else duplicates++;
              }

              if (itemRow?.kcs) {
                const kcsArr = String(itemRow.kcs).split("|").map((s: string) => s.trim()).filter(Boolean);
                for (const kc of kcsArr) {
                  const row = await env.DB.prepare(
                    `SELECT total_attempts, correct_attempts, streak FROM kc_stats WHERE user_id=? AND kc=?`
                  ).bind(user_id, kc).first<any>();

                  const isRight = !!serverCorrect;
                  if (row) {
                    const total = (row.total_attempts ?? 0) + 1;
                    const correct = (row.correct_attempts ?? 0) + (isRight ? 1 : 0);
                    const rate = total ? correct / total : 0;
                    const streak = isRight ? ((row.streak ?? 0) + 1) : 0;
                    await env.DB.prepare(
                      `UPDATE kc_stats SET total_attempts=?, correct_attempts=?, correct_rate=?, streak=?, last_ts=? WHERE user_id=? AND kc=?`
                    ).bind(total, correct, rate, streak, ts, user_id, kc).run();
                  } else {
                    await env.DB.prepare(
                      `INSERT INTO kc_stats(user_id, kc, w, correct_rate, total_attempts, correct_attempts, streak, last_ts)
                       VALUES(?,?,?,?,?,?,?,?)`
                    ).bind(user_id, kc, 1.0, isRight ? 1.0 : 0.0, 1, isRight ? 1 : 0, isRight ? 1 : 0, ts).run();
                  }
                }
              }

              touched.add(item_id);
            } catch (e: any) {
              failures.push({ i, reason: String(e?.message || e) });
            }
          }

          // 批次後再針對每個被觸及的 item 檢查是否需要 quarantine
          for (const item_id of touched) {
            try { await checkAndQuarantineItem(env, item_id); } catch {}
          }          

          const payload = { inserted, updated, duplicates, failures };
          return j(payload, failures.length ? 207 : 200, origin); // 207: Multi-Status
        } catch (e: any) {
          return j({ error: "attempts_bulk_failed", detail: String(e?.message || e) }, 500, origin);
        }
      }

      // POST /api/process/eval (workpad step evaluation)
      if (url.pathname === "/api/process/eval" && req.method === "POST") {
        if (!bearerOk(req, env)) return j({ error: "unauthorized" }, 401, origin);
        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        if (!(await rateLimit(env, `eval:${ip}`, 60, 60))) return j({ error: "rate_limited" }, 429, origin);
        try {
          const body = await req.json().catch(() => ({}));
          const stem = String(body.stem ?? "");
          const solution = String(body.solution ?? "");
          const steps = body.steps ?? {};
          const preferStrong = !!body.policy?.strong;

          const prompt = `
題目：${stem}
參考解（可省略）：${solution || "無"}
學生步驟（JSON）：
${JSON.stringify(steps)}

請檢查每一步是否合理與正確，指出第一個錯誤點，並按照 rubric 給分（setup/operations/units/presentation）。
輸出 JSON：{verdict, reasoning, rubric:{setup,operations,units,presentation}, confidence}
`.trim();

          const res = await gptEvaluate(env, prompt, preferStrong, 600);
          let parsed: any;
          try { parsed = JSON.parse(res.text); } catch { parsed = { verdict: "uncertain", reasoning: "模型未回有效 JSON", confidence: 0 }; }
          return j({ model: res.model, result: parsed }, 200, origin);
        } catch (e: any) {
          return j({ error: "process_eval_failed", detail: String(e?.message || e) }, 500, origin);
        }
      }

      // POST /api/items (single create, admin)
      if (url.pathname === "/api/items" && req.method === "POST") {
        if (!bearerOk(req, env)) return j({ error: "unauthorized" }, 401, origin);
        try {
          const body = await req.json().catch(() => ({}));

          const id          = String(body.id || crypto.randomUUID());
          const subject     = String(body.subject || "math");
          const grade       = String(body.grade || "g7");
          const unit        = String(body.unit || "");
          const item_type   = String(body.item_type || "single");
          const difficulty  = Number.isFinite(+body.difficulty) ? +body.difficulty : 2;
          const stem        = String(body.stem || "");
          const solution    = body.solution != null ? String(body.solution) : "";
          const status      = String(body.status || "published");

          const kcs     = Array.isArray(body.kcs) ? body.kcs.join("|") : (body.kcs ? String(body.kcs) : "");
          const tags    = Array.isArray(body.tags) ? body.tags.join("|") : (body.tags ? String(body.tags) : "");
          const source  = body.source ? String(body.source) : "manual";

          const choices = body.choices != null ? JSON.stringify(body.choices) : null;
          const answer  = body.answer  != null ? JSON.stringify(body.answer)  : null;

          if (!stem) return j({ error: "missing_stem" }, 400, origin);
          if (!["single","multiple","numeric","text","cloze","ordering","matching","tablefill","truefalse"].includes(item_type)) {
            return j({ error: "bad_item_type" }, 400, origin);
          }

          await env.DB.prepare(
            `INSERT INTO items
             (id, subject, grade, unit, kcs, item_type, difficulty, stem, choices, answer, solution, tags, source, status, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))`
          ).bind(
            id, subject, grade, unit, kcs, item_type, difficulty, stem, choices, answer, solution, tags, source, status
          ).run();

          return j({ ok: true, id }, 200, origin);
        } catch (e:any) {
          return j({ error: "item_create_failed", detail: String(e?.message || e) }, 500, origin);
        }
      }

      // 404
      return j({ error: "not_found" }, 404, origin);
    } catch (e:any) {
      const origin2 = pickOrigin(env.ALLOW_ORIGIN, req.headers.get("Origin"));
      return j({ error: "internal_error", detail: String(e?.message || e) }, 500, origin2);
    }
  }
} as WorkerHandler;
