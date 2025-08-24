/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export interface Env {
  DB: D1Database;
  AFTERCLASS_KV?: KVNamespace; //
  KV: KVNamespace;
  ALLOW_ORIGIN: string;        // 逗號分隔的允許清單，如 "https://x.pages.dev,https://study.g4z.cloudflare"
  OPENAI_API_KEY?: string;     // wrangler secret put OPENAI_API_KEY
  API_BEARER?: string;         // wrangler secret put API_BEARER（可選，若設置則需驗證）
}

/* ----------------------- 小工具 & 基礎 ----------------------- */

function pickOrigin(allowList: string, reqOrigin: string | null): string {
  if (!allowList) return "*";  // 若未設定，開放（建議正式環境一定要設）
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
	new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(o) } });
const no = (o: string) => new Response(null, { status: 204, headers: corsHeaders(o) });

function bearerOk(req: Request, env: Env): boolean {
  if (!env.API_BEARER) return true; // 未設定即代表不強制驗證
  const auth = req.headers.get("Authorization") || "";
  return auth === `Bearer ${env.API_BEARER}`;
}

/** 極簡 KV 節流：每 IP 每分鐘最多 N 次 */
async function rateLimit(env: Env, key: string, limit = 60, ttlSec = 60): Promise<boolean> {
  const kv = env.AFTERCLASS_KV ?? env.KV;
  if (!kv) return true; // 沒有 KV 綁定時，不做節流，避免 throw
  const bucket = `rl:${key}:${Math.floor(Date.now() / (ttlSec * 1000))}`;
  const v = await kv.get(bucket);
  const n = v ? parseInt(v, 10) : 0;
  if (n >= limit) return false;
  await kv.put(bucket, String(n + 1), { expirationTtl: ttlSec + 5 });
  return true;
}


/* ----------------------- 判題邏輯（後端） ----------------------- */
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
  // 支援分數/小數
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

/** 後端評分，回傳 0/1 */
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
        return raw && typeof raw.value === "string" &&
          eqNumeric(raw.value, correctAns.value, tol) ? 1 : 0;
      }
      case "text": {
        const cand = typeof raw?.text === "string" ? raw.text : (Array.isArray(raw?.accept) ? raw.accept[0] : "");
        const norm = normStr(String(cand || ""));
        return correctAns.accept.some(acc => normStr(acc) === norm) ? 1 : 0;
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
        // 比較成集合（忽略順序）
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

/* ----------------------- GPT 雙層（文字/JSON步驟） ----------------------- */
async function gptEvaluate(env: Env, prompt: string, preferStrong = false, maxTokens = 500) {
  if (!env.OPENAI_API_KEY) {
    return { model: "none", text: JSON.stringify({
      verdict: "uncertain",
      reasoning: "OPENAI_API_KEY 未設定，返回示意結果。",
      rubric: { setup: 0, operations: 0, units: 0, presentation: 0 },
      confidence: 0
    }) };
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
    // 若解析得到高信心或非不確定，就停
    try {
      const o = JSON.parse(last);
      if (o.verdict !== "uncertain" && (o.confidence ?? 0.5) >= 0.6) {
        return { model, text: last };
      }
    } catch { /* 升級下一層 */ }
  }
  return { model: preferStrong ? "gpt-4o" : "gpt-4o-mini", text: last || JSON.stringify({ verdict: "uncertain", reasoning: "模型未返回有效 JSON", confidence: 0 }) };
}

/* ----------------------- 主處理器 ----------------------- */
export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const origin = pickOrigin(env.ALLOW_ORIGIN, req.headers.get("Origin"));

		try {
		const url = new URL(req.url);

		if (req.method === "OPTIONS") return no(origin);

		// 健康檢查
		if (url.pathname === "/api/health" && req.method === "GET") {
			return j({ ok: true, time: new Date().toISOString() }, 200, origin);
		}

		// 題目查詢：?subject=&unit=&kc=&q=&n=&page=&random=1
		if (url.pathname === "/api/items" && req.method === "GET") {
			try {
				const subject = url.searchParams.get("subject");
				const unit = url.searchParams.get("unit");
				const kc = url.searchParams.get("kc");
				const q = url.searchParams.get("q");
				const n = Math.max(1, Math.min(50, Number(url.searchParams.get("n") || 10)));
				const page = Math.max(1, Number(url.searchParams.get("page") || 1));
				const random = url.searchParams.get("random") === "1";

				let sql = `SELECT * FROM items WHERE status='published'`;
				const params: any[] = [];
				if (subject) { sql += ` AND subject=?`; params.push(subject); }
				if (unit)    { sql += ` AND unit=?`;    params.push(unit); }
				if (kc)      { sql += ` AND kcs LIKE ?`;params.push(`%${kc}%`); }
				if (q)       { sql += ` AND (stem LIKE ? OR solution LIKE ?)`; params.push(`%${q}%`,`%${q}%`); }
				sql += random ? ` ORDER BY random()` : ` ORDER BY created_at DESC`;
				sql += ` LIMIT ? OFFSET ?`; params.push(n, (page - 1) * n);

				const { results } = await env.DB.prepare(sql).bind(...params).all();
				const data = (results as any[]).map(r => ({
				id: r.id, subject: r.subject, grade: r.grade, unit: r.unit,
				kcs: r.kcs ? String(r.kcs).split("|") : [],
				item_type: r.item_type, difficulty: r.difficulty,
				stem: r.stem,
				choices: r.choices ? JSON.parse(r.choices) : null,
				answer: r.answer ? JSON.parse(r.answer) : null,
				solution: r.solution,
				tags: r.tags ? String(r.tags).split("|") : [],
				source: r.source, status: r.status
				}));
				return j({ page, count: data.length, items: data }, 200, origin);
			} catch (e: any) {
				return j({ error: "items_query_failed", detail: String(e?.message || e) }, 500, origin);
			}
	    }

		// 題目單筆
		if (url.pathname.startsWith("/api/items/") && req.method === "GET") {
			try {
				const id = url.pathname.split("/").pop()!;
				const { results } = await env.DB.prepare(`SELECT * FROM items WHERE id=?`).bind(id).all();
				if (!results || (results as any[]).length === 0) return j({ error: "not_found" }, 404, origin);
				const r: any = (results as any[])[0];
				return j({
					id: r.id, subject: r.subject, grade: r.grade, unit: r.unit,
					kcs: r.kcs ? String(r.kcs).split("|") : [],
					item_type: r.item_type, difficulty: r.difficulty,
					stem: r.stem,
					choices: r.choices ? JSON.parse(r.choices) : null,
					answer: r.answer ? JSON.parse(r.answer) : null,
					solution: r.solution,
					tags: r.tags ? String(r.tags).split("|") : [],
					source: r.source, status: r.status
				}, 200, origin);
			} catch (e: any) {
				return j({ error: "item_fetch_failed", detail: String(e?.message || e) }, 500, origin);
			}
		}

		// 批次作答（冪等 + 伺服器端判題 + kc_stats）
		if (url.pathname === "/api/attempts/bulk" && req.method === "POST") {
			if (!bearerOk(req, env)) return j({ error: "unauthorized" }, 401, origin);
			const ip = req.headers.get("CF-Connecting-IP") || "unknown";
			if (!(await rateLimit(env, `attempts:${ip}`, 180, 60))) return j({ error: "rate_limited" }, 429, origin);

			try {
				const body = await req.json().catch(() => ({}));
				const attempts = Array.isArray(body.attempts) ? body.attempts : [];
				if (attempts.length === 0) return j({ inserted: 0, updated: 0, duplicates: 0 }, 200, origin);

				let inserted = 0, updated = 0, duplicates = 0;

				for (const a of attempts) {
					// 取正解
					const itemRow = await env.DB.prepare(`SELECT id,answer,kcs FROM items WHERE id=?`).bind(a.item_id).first<any>();
					const ans: Answer | null = itemRow?.answer ? JSON.parse(itemRow.answer) : null;

					// 後端判分（若取不到正解就用 0）
					const serverCorrect = ans ? grade(a.raw_answer, ans) : 0;

					// INSERT OR IGNORE
					const ins = await env.DB.prepare(
						`INSERT OR IGNORE INTO attempts
						(attempt_id,user_id,item_id,ts,elapsed_sec,raw_answer,correct,attempts,work_url,process_json,rubric_json,eval_model,device_id,session_id)
						VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
					).bind(
						a.attempt_id, a.user_id, a.item_id, a.ts, a.elapsed_sec,
						a.raw_answer != null ? JSON.stringify(a.raw_answer) : null,
						serverCorrect,
						a.attempts ?? 1,
						a.work_url ?? null,
						a.process_json != null ? JSON.stringify(a.process_json) : null,
						a.rubric_json  != null ? JSON.stringify(a.rubric_json)  : null,
						a.eval_model ?? null,
						a.device_id ?? null,
						a.session_id ?? null
					).run();

					if (ins.success && ins.meta.changes === 1) {
						inserted++;
					} else {
						const upd = await env.DB.prepare(
							`UPDATE attempts SET user_id=?, item_id=?, ts=?, elapsed_sec=?, raw_answer=?, correct=?, attempts=?,
							work_url=?, process_json=?, rubric_json=?, eval_model=?, device_id=?, session_id=?
							WHERE attempt_id=?`
						).bind(
							a.user_id, a.item_id, a.ts, a.elapsed_sec,
							a.raw_answer != null ? JSON.stringify(a.raw_answer) : null,
							serverCorrect,
							a.attempts ?? 1,
							a.work_url ?? null,
							a.process_json != null ? JSON.stringify(a.process_json) : null,
							a.rubric_json  != null ? JSON.stringify(a.rubric_json)  : null,
							a.eval_model ?? null,
							a.device_id ?? null,
							a.session_id ?? null,
							a.attempt_id
						).run();
						if (upd.meta.changes === 1) updated++; else duplicates++;
					}

					// 更新 kc_stats（簡版：每題的 kcs 以 "|" 拆，逐一累計）
					if (itemRow?.kcs) {
						const arr = String(itemRow.kcs).split("|").map((s: string) => s.trim()).filter(Boolean);
						for (const kc of arr) {
							const row = await env.DB.prepare(`SELECT total_attempts,correct_attempts FROM kc_stats WHERE user_id=? AND kc=?`).bind(a.user_id, kc).first<any>();
							if (row) {
								const total = (row.total_attempts ?? 0) + 1;
								const correct = (row.correct_attempts ?? 0) + (serverCorrect ? 1 : 0);
								const rate = total ? correct / total : 0;
								await env.DB.prepare(
									`UPDATE kc_stats SET total_attempts=?, correct_attempts=?, correct_rate=?, streak=?, last_ts=? WHERE user_id=? AND kc=?`
								).bind(
									total, correct, rate,
									serverCorrect ? ( (row.streak ?? 0) + 1 ) : 0,
									a.ts, a.user_id, kc
								).run();
							} else {
								await env.DB.prepare(
									`INSERT INTO kc_stats(user_id,kc,w,correct_rate,total_attempts,correct_attempts,streak,last_ts)
									VALUES(?,?,?,?,?,?,?,?)`
								).bind(
									a.user_id, kc, 1.0, serverCorrect ? 1.0 : 0.0, 1, serverCorrect ? 1 : 0, serverCorrect ? 1 : 0, a.ts
								).run();
							}
						}
					}
				}
				return j({ inserted, updated, duplicates }, 200, origin);
			} catch (e: any) {
				return j({ error: "attempts_bulk_failed", detail: String(e?.message || e) }, 500, origin);
			}
		}

		// 計算過程評估（JSON步驟）—— GPT 雙層
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
		// 無匹配
    	return j({ error: "not_found" }, 404, origin);
	} catch (e:any) {
		// 最後防線：任何未捕捉錯誤都回 JSON + CORS
		const origin = pickOrigin(env.ALLOW_ORIGIN, req.headers.get("Origin"));
		return j({ error: "internal_error", detail: String(e?.message || e) }, 500, origin);
	}
	}
} satisfies ExportedHandler<Env>;
