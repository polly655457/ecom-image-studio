/* ============================================================================
 * 共享额度配额代理 · Cloudflare Worker
 * ----------------------------------------------------------------------------
 * 作用：让同事「点进去就能直接用」，无需各自填 Key，并按人限额 200。
 *       页面只发 prompt + 工号，密钥留在这里，绝不下发到浏览器。
 *
 * 重要：这里消耗的是管理员自己的生图 API 账户费用，不是 WorkBuddy 积分。
 *       WorkBuddy 积分是会话内消耗，没有可被网页按人调用的HTTP接口。
 *       若确实要扣 WorkBuddy 积分，请用页面上的「导出任务包」半自动通道。
 *
 * ----------------------------------------------------------------------------
 * 部署（约 5 分钟）
 *
 * 1) npm i -g wrangler && wrangler login
 * 2) 新建 wrangler.toml：
 *
 *      name = "ecom-image-quota"
 *      main = "quota-worker.js"
 *      compatibility_date = "2026-01-01"
 *
 *      [[kv_namespaces]]
 *      binding = "QUOTA"
 *      id = "<wrangler kv namespace create QUOTA 输出的 id>"
 *
 *    [vars] 里可写：
 *      UPSTREAM_BASE = "https://api.openai.com/v1"
 *      UPSTREAM_MODEL = "gpt-image-1"
 *      QUOTA_LIMIT = "200"
 *      ALLOWED_ORIGIN = "https://<用户名>.github.io"   # 建议填，留空则不限制来源
 *
 * 3) 密钥不要写进文件：
 *      wrangler secret put UPSTREAM_KEY
 *
 * 4) wrangler deploy
 *
 * 5) 把得到的 https://ecom-image-quota.<账号>.workers.dev
 *    填进 index.html 顶部的 ADMIN_CONFIG.QUOTA_PROXY，重新推 GitHub Pages 即可。
 *
 * 注意：KV 是最终一致，极端并发下可能少量超额；团队内部使用足够。
 *       需要严格原子配额请改用 Durable Objects。
 * ========================================================================== */

const CORS_BASE = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Id",
  "Access-Control-Max-Age": "86400"
};

function cors(origin, allowed) {
  const h = { ...CORS_BASE };
  h["Access-Control-Allow-Origin"] = allowed || origin || "*";
  if (allowed) h["Vary"] = "Origin";
  return h;
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json;charset=utf-8", ...(headers || {}) }
  });
}
function cleanUser(v) {
  // 只接受简单的工号/昵称，避免把任意字符串当 KV key 滥用
  const s = String(v || "").trim().toLowerCase();
  return /^[a-z0-9._-]{1,48}$/.test(s) ? s : null;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "";
    const headers = cors(origin, allowed);

    if (allowed && origin && origin !== allowed) {
      return json({ error: "来源未被允许" }, 403, headers);
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    const url = new URL(request.url);
    const limit = Number(env.QUOTA_LIMIT || 200);

    // ---- 查询余额 ----
    if (url.pathname === "/quota" && request.method === "GET") {
      const user = cleanUser(url.searchParams.get("userId"));
      if (!user) return json({ error: "工号格式不合法" }, 400, headers);
      const used = Number(await env.QUOTA.get("used:" + user) || 0);
      return json({ user, used, limit, remaining: Math.max(0, limit - used) }, 200, headers);
    }

    // ---- 生成 ----
    if (url.pathname === "/generate" && request.method === "POST") {
      const user = cleanUser(request.headers.get("X-User-Id"));
      if (!user) return json({ error: "请先在设置里填写工号（字母/数字/._-，1–48 位）" }, 400, headers);

      let body;
      try { body = await request.json(); }
      catch (e) { return json({ error: "请求体不是合法 JSON" }, 400, headers); }
      if (!body.prompt || String(body.prompt).length > 12000) {
        return json({ error: "提示词为空或过长" }, 400, headers);
      }

      const key = "used:" + user;
      const used = Number(await env.QUOTA.get(key) || 0);
      if (used >= limit) {
        return json({ error: "你的 " + limit + " 额度已用完，请联系管理员", used, limit, remaining: 0 },
          429, headers);
      }

      if (!env.UPSTREAM_BASE || !env.UPSTREAM_KEY) {
        return json({ error: "管理员尚未配置上游接口密钥" }, 503, headers);
      }

      const upstream = await fetch(env.UPSTREAM_BASE.replace(/\/+$/, "") + "/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + env.UPSTREAM_KEY
        },
        body: JSON.stringify({
          model: env.UPSTREAM_MODEL || "gpt-image-1",
          prompt: String(body.prompt),
          size: body.size || "1024x1024",
          quality: body.quality || "high",
          n: 1,                       // 批量由页面循环调用，逐张记账
          response_format: "b64_json"
        })
      });

      const data = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        // 上游失败不扣额度
        const detail = (data.error && data.error.message) || ("HTTP " + upstream.status);
        return json({ error: "上游生图失败：" + detail }, 502, headers);
      }

      const first = (data.data || [])[0] || {};
      let image = "";
      if (first.b64_json) image = "data:image/png;base64," + first.b64_json;
      else if (first.url) image = first.url;
      else if (data.image) image = data.image;
      if (!image) return json({ error: "上游响应里没找到图片" }, 502, headers);

      const next = used + 1;
      await env.QUOTA.put(key, String(next));
      return json({ image, used: next, limit, remaining: Math.max(0, limit - next) }, 200, headers);
    }

    return json({ error: "not found" }, 404, headers);
  }
};
