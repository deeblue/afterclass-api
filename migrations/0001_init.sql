-- 題庫 items（多題型答案以 JSON 文字存放於 answer 欄）
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  grade TEXT NOT NULL,
  unit TEXT NOT NULL,
  kcs TEXT NOT NULL,
  item_type TEXT NOT NULL,
  difficulty INTEGER NOT NULL,
  stem TEXT NOT NULL,
  choices TEXT,
  answer TEXT NOT NULL,
  solution TEXT NOT NULL,
  tags TEXT DEFAULT '',
  source TEXT DEFAULT '',
  status TEXT DEFAULT 'published',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 答案 JSON 規範（寫入 items.answer 之 TEXT 內容）
-- 單選：  {"kind":"single","index":2}
-- 多選：  {"kind":"multiple","indices":[1,3]}
-- 數值：  {"kind":"numeric","value":"3/4","tolerance":"0"}
-- 文字：  {"kind":"text","accept":["垂直平分線","垂直平分線段"]}
-- 填空：  {"kind":"cloze","blanks":["3","4/5","cm^2"]}

-- 作答紀錄 attempts（含「過程」欄位；本版不存影像檔）
CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  elapsed_sec INTEGER NOT NULL,
  raw_answer TEXT,
  correct INTEGER NOT NULL,
  attempts INTEGER DEFAULT 1,
  work_url TEXT,
  process_json TEXT,
  rubric_json TEXT,
  eval_model TEXT,
  device_id TEXT,
  session_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attempts_user_ts ON attempts(user_id, ts);

-- 知識點統計 kc_stats
CREATE TABLE IF NOT EXISTS kc_stats (
  user_id TEXT NOT NULL,
  kc TEXT NOT NULL,
  w REAL NOT NULL DEFAULT 1.0,
  correct_rate REAL NOT NULL DEFAULT 0.0,
  total_attempts INTEGER DEFAULT 0,
  correct_attempts INTEGER DEFAULT 0,
  streak INTEGER DEFAULT 0,
  last_ts TEXT,
  PRIMARY KEY (user_id, kc)
);
