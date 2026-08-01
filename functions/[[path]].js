/**
 * Cloudflare Pages Function - 通用 CORS 代理服务
 * 支持两种调用方式：
 * 1. 路径形式: https://your-domain.com/https://example.com
 * 2. 参数形式: https://your-domain.com/?url=https://example.com
 */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;

  // 1. 静态资源和本站关键路径绕过（让 Pages 原生处理）
  const isStaticAsset =
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname === "/logo.ico" ||
    pathname === "/logo.gif" ||
    pathname === "/_headers" ||
    pathname === "/wrangler.toml" ||
    pathname === "/wrangler.json";

  if (isStaticAsset) {
    return context.next();
  }

  // 2. 获取目标 URL
  let targetUrl = url.searchParams.get("url");

  if (!targetUrl) {
    // 尝试从路径中直接解析目标 URL (例如 /https://example.com)
    const candidate = pathname.startsWith("/") ? pathname.slice(1) : pathname;

    // 如果路径以 http 开头，说明它是一个待代理的 URL
    if (candidate.startsWith("http")) {
      // 拼接上原始请求的查询参数（如果有）
      targetUrl = decodeURIComponent(candidate) + url.search;
    }
  }

  // 3. 处理 OPTIONS 预检请求
  if (request.method === "OPTIONS") {
    return handleCORS();
  }

  // 4. 如果仍未找到有效的代理目标，且不是忽略路径，则返回 context.next()
  if (!targetUrl) {
    return context.next();
  }

  try {
    // 解码并规范化目标 URL
    const decodedUrl = targetUrl.startsWith("http")
      ? targetUrl
      : decodeURIComponent(targetUrl);

    // 构建代理请求选项
    const proxyRequestInit = {
      method: request.method,
      headers: {},
      redirect: "follow",
    };

    // 复制请求头（排除 Host 等敏感或受限头）
    const excludeHeaders = ["host", "origin", "referer", "cookie"];
    for (const [key, value] of request.headers) {
      const lowerKey = key.toLowerCase();
      if (!excludeHeaders.includes(lowerKey)) {
        proxyRequestInit.headers[key] = value;
      }
    }

    // 处理请求体（仅限有 Body 的方法）
    if (["POST", "PUT", "PATCH"].includes(request.method)) {
      proxyRequestInit.body = await request.text();
    }

    // 发起代理请求（添加 10 秒超时控制）
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(decodedUrl, {
        ...proxyRequestInit,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      // 复制原始响应头并添加跨域所需的 CORS 头
      const responseHeaders = new Headers(response.headers);
      const corsHeaders = getCORSHeaders();

      for (const [key, value] of Object.entries(corsHeaders)) {
        responseHeaders.set(key, value);
      }

      // 禁止响应被强缓存
      responseHeaders.set(
        "Cache-Control",
        "no-store, no-cache, must-revalidate",
      );
      responseHeaders.set("Pragma", "no-cache");
      responseHeaders.set("Expires", "0");

      // 返回代理后的响应
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError.name === "AbortError") {
        return new Response("代理请求超时", {
          status: 504,
          headers: getCORSHeaders(),
        });
      }
      throw fetchError;
    }
  } catch (error) {
    return new Response(`代理请求失败: ${error.message}`, {
      status: 500,
      headers: getCORSHeaders(),
    });
  }
}

/**
 * 处理 CORS 预检
 */
function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: getCORSHeaders(),
  });
}

/**
 * 获取标准 CORS 响应头
 */
function getCORSHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Expose-Headers": "*",
  };
}
