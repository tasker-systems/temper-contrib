// node_modules/@tasker-systems/temper-ts/dist/validate.js
function isLoopback(hostname) {
  const host = hostname.replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return true;
  }
  return host === "::1" || host === "[::1]";
}
function requireEndpoint(value, name, opts = {}) {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (/\s/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} must not contain whitespace or control characters`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${name} is not a parseable URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" || url.hostname === "") {
    throw new TypeError(`${name} must be an absolute http(s) URL`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new TypeError(`${name} must not carry userinfo (user:password@); pass credentials to ClientCredentials or BearerToken instead`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new TypeError(`${name} must be an origin (optionally with a path prefix), not a URL with a query or fragment`);
  }
  if (url.protocol === "http:" && !(opts.allowInsecureHttp === true || isLoopback(url.hostname))) {
    throw new TypeError(`${name} is plaintext http to a non-loopback host, which would put the bearer token and client_secret on the wire in the clear; use https, or pass allowInsecureHttp: true to accept that deliberately`);
  }
  return url;
}

// node_modules/@tasker-systems/temper-ts/dist/credentials.js
var TokenMintError = class extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.name = "TokenMintError";
    this.status = status;
  }
};
var BearerToken = class {
  canRefresh = false;
  #token;
  constructor(token) {
    if (token === "") {
      throw new TypeError("token must be a non-empty string");
    }
    this.#token = token;
  }
  async token() {
    return this.#token;
  }
  async tokenResult() {
    return { token: this.#token, expiresAt: Number.POSITIVE_INFINITY };
  }
  async refresh() {
    throw new TokenMintError("BearerToken cannot refresh; mint a new token upstream", 401);
  }
};
function isTokenResponseBody(body) {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const fields = body;
  return typeof fields.access_token === "string" && fields.access_token !== "" && typeof fields.expires_in === "number" && Number.isFinite(fields.expires_in);
}
var ClientCredentials = class _ClientCredentials {
  /** Re-mint this far AHEAD of expiry rather than racing it. */
  static SKEW_MS = 6e4;
  canRefresh = true;
  #tokenUrl;
  #clientId;
  #clientSecret;
  #audience;
  #now;
  #cached;
  /** The mutex, in JS idiom — see the class comment. Non-undefined exactly while a mint is in flight. */
  #inFlight;
  constructor(opts) {
    requireEndpoint(opts.tokenUrl, "tokenUrl", { allowInsecureHttp: opts.allowInsecureHttp });
    this.#tokenUrl = requireNonEmpty(opts.tokenUrl, "tokenUrl");
    this.#clientId = requireNonEmpty(opts.clientId, "clientId");
    this.#clientSecret = requireNonEmpty(opts.clientSecret, "clientSecret");
    this.#audience = opts.audience === void 0 ? void 0 : requireNonEmpty(opts.audience, "audience");
    this.#now = opts.now ?? (() => Date.now());
  }
  async token() {
    return (await this.tokenResult()).token;
  }
  async tokenResult() {
    if (this.#cached !== void 0 && this.#cached.expiresAt - _ClientCredentials.SKEW_MS > this.#now()) {
      return this.#cached;
    }
    return this.refresh();
  }
  /**
   * Mint unconditionally, discarding any cached token. The on-401 path — see the class comment.
   *
   * Concurrent callers COALESCE onto one mint. N parallel fetches sharing a token that dies mid-tick
   * all take a 401 and all land here at once; without this they would buy N tokens to answer one
   * expiry.
   */
  async refresh() {
    this.#inFlight ??= this.#mint().finally(() => {
      this.#inFlight = void 0;
    });
    return this.#inFlight;
  }
  async #mint() {
    const res = await fetch(this.#tokenUrl, {
      method: "POST",
      // RFC 6749 §4 mandates form encoding. Auth0 tolerates JSON, which is why a JSON mint stayed
      // green for as long as Auth0 was the only issuer any client faced; temper's AS reads the body
      // with `req.formData()` and a JSON mint never reaches its grant branch.
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: this.#requestBody(),
      // Never follow a redirect: a 307/308 resends this body, client_secret included, to wherever it
      // points, and `requireEndpoint` vetted only the token URL. temper-py's mint refuses them too.
      redirect: "error"
    });
    if (!res.ok) {
      throw new TokenMintError(`token mint failed (${res.status}): ${await res.text()}`, res.status);
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new TokenMintError(`token mint returned a non-JSON body (${res.status})`, res.status);
    }
    if (!isTokenResponseBody(body)) {
      throw new TokenMintError(`token mint returned a ${res.status} without a usable access_token/expires_in`, res.status);
    }
    this.#cached = {
      token: body.access_token,
      expiresAt: this.#now() + body.expires_in * 1e3
    };
    return this.#cached;
  }
  #requestBody() {
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.#clientId,
      client_secret: this.#clientSecret
    });
    if (this.#audience !== void 0) {
      params.set("audience", this.#audience);
    }
    return params;
  }
};
function requireNonEmpty(value, name) {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

// node_modules/@tasker-systems/temper-ts/dist/auth-fetch.js
var SURFACE = "sdk";
function authorize(request, token) {
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("x-temper-surface", SURFACE);
  return new Request(request, { headers });
}
function createAuthedFetch(opts) {
  const { credentials } = opts;
  const inner = opts.fetch ?? ((input) => fetch(input));
  return async (input) => {
    const pristine = input.clone();
    const used = await credentials.token();
    const response = await inner(authorize(input, used));
    if (response.status !== 401 || !credentials.canRefresh) {
      return response;
    }
    void response.body?.cancel();
    const current = await credentials.tokenResult();
    const token = current.token !== used ? current.token : (await credentials.refresh()).token;
    return inner(authorize(pristine, token));
  };
}

// node_modules/openapi-fetch/dist/index.mjs
var PATH_PARAM_RE = /\{[^{}]+\}/g;
var supportsRequestInitExt = () => {
  return typeof process === "object" && Number.parseInt(process?.versions?.node?.substring(0, 2)) >= 18 && process.versions.undici;
};
function randomID() {
  return Math.random().toString(36).slice(2, 11);
}
function createClient(clientOptions) {
  let {
    baseUrl = "",
    Request: CustomRequest = globalThis.Request,
    fetch: baseFetch = globalThis.fetch,
    querySerializer: globalQuerySerializer,
    bodySerializer: globalBodySerializer,
    pathSerializer: globalPathSerializer,
    headers: baseHeaders,
    requestInitExt = void 0,
    ...baseOptions
  } = { ...clientOptions };
  requestInitExt = supportsRequestInitExt() ? requestInitExt : void 0;
  baseUrl = removeTrailingSlash(baseUrl);
  const globalMiddlewares = [];
  async function coreFetch(schemaPath, fetchOptions) {
    const {
      baseUrl: localBaseUrl,
      fetch: fetch2 = baseFetch,
      Request: Request2 = CustomRequest,
      headers,
      params = {},
      parseAs = "json",
      querySerializer: requestQuerySerializer,
      bodySerializer = globalBodySerializer ?? defaultBodySerializer,
      pathSerializer: requestPathSerializer,
      body,
      middleware: requestMiddlewares = [],
      ...init
    } = fetchOptions || {};
    let finalBaseUrl = baseUrl;
    if (localBaseUrl) {
      finalBaseUrl = removeTrailingSlash(localBaseUrl) ?? baseUrl;
    }
    let querySerializer = typeof globalQuerySerializer === "function" ? globalQuerySerializer : createQuerySerializer(globalQuerySerializer);
    if (requestQuerySerializer) {
      querySerializer = typeof requestQuerySerializer === "function" ? requestQuerySerializer : createQuerySerializer({
        ...typeof globalQuerySerializer === "object" ? globalQuerySerializer : {},
        ...requestQuerySerializer
      });
    }
    const pathSerializer = requestPathSerializer || globalPathSerializer || defaultPathSerializer;
    const serializedBody = body === void 0 ? void 0 : bodySerializer(
      body,
      // Note: we declare mergeHeaders() both here and below because it’s a bit of a chicken-or-egg situation:
      // bodySerializer() needs all headers so we aren’t dropping ones set by the user, however,
      // the result of this ALSO sets the lowest-priority content-type header. So we re-merge below,
      // setting the content-type at the very beginning to be overwritten.
      // Lastly, based on the way headers work, it’s not a simple “present-or-not” check becauase null intentionally un-sets headers.
      mergeHeaders(baseHeaders, headers, params.header)
    );
    const finalHeaders = mergeHeaders(
      // with no body, we should not to set Content-Type
      serializedBody === void 0 || // if serialized body is FormData; browser will correctly set Content-Type & boundary expression
      serializedBody instanceof FormData ? {} : {
        "Content-Type": "application/json"
      },
      baseHeaders,
      headers,
      params.header
    );
    const finalMiddlewares = [...globalMiddlewares, ...requestMiddlewares];
    const requestInit = {
      redirect: "follow",
      ...baseOptions,
      ...init,
      body: serializedBody,
      headers: finalHeaders
    };
    let id;
    let options;
    let request = new Request2(
      createFinalURL(schemaPath, { baseUrl: finalBaseUrl, params, querySerializer, pathSerializer }),
      requestInit
    );
    let response;
    for (const key in init) {
      if (!(key in request)) {
        request[key] = init[key];
      }
    }
    if (finalMiddlewares.length) {
      id = randomID();
      options = Object.freeze({
        baseUrl: finalBaseUrl,
        fetch: fetch2,
        parseAs,
        querySerializer,
        bodySerializer,
        pathSerializer
      });
      for (const m of finalMiddlewares) {
        if (m && typeof m === "object" && typeof m.onRequest === "function") {
          const result = await m.onRequest({
            request,
            schemaPath,
            params,
            options,
            id
          });
          if (result) {
            if (result instanceof Request2) {
              request = result;
            } else if (result instanceof Response) {
              response = result;
              break;
            } else {
              throw new Error("onRequest: must return new Request() or Response() when modifying the request");
            }
          }
        }
      }
    }
    if (!response) {
      try {
        response = await fetch2(request, requestInitExt);
      } catch (error2) {
        let errorAfterMiddleware = error2;
        if (finalMiddlewares.length) {
          for (let i = finalMiddlewares.length - 1; i >= 0; i--) {
            const m = finalMiddlewares[i];
            if (m && typeof m === "object" && typeof m.onError === "function") {
              const result = await m.onError({
                request,
                error: errorAfterMiddleware,
                schemaPath,
                params,
                options,
                id
              });
              if (result) {
                if (result instanceof Response) {
                  errorAfterMiddleware = void 0;
                  response = result;
                  break;
                }
                if (result instanceof Error) {
                  errorAfterMiddleware = result;
                  continue;
                }
                throw new Error("onError: must return new Response() or instance of Error");
              }
            }
          }
        }
        if (errorAfterMiddleware) {
          throw errorAfterMiddleware;
        }
      }
      if (finalMiddlewares.length) {
        for (let i = finalMiddlewares.length - 1; i >= 0; i--) {
          const m = finalMiddlewares[i];
          if (m && typeof m === "object" && typeof m.onResponse === "function") {
            const result = await m.onResponse({
              request,
              response,
              schemaPath,
              params,
              options,
              id
            });
            if (result) {
              if (!(result instanceof Response)) {
                throw new Error("onResponse: must return new Response() when modifying the response");
              }
              response = result;
            }
          }
        }
      }
    }
    const contentLength = response.headers.get("Content-Length");
    if (response.status === 204 || request.method === "HEAD" || contentLength === "0" && !response.headers.get("Transfer-Encoding")?.includes("chunked")) {
      return response.ok ? { data: void 0, response } : { error: void 0, response };
    }
    if (response.ok) {
      const getResponseData = async () => {
        if (parseAs === "stream") {
          return response.body;
        }
        if (parseAs === "json" && !contentLength) {
          const raw = await response.text();
          return raw ? JSON.parse(raw) : void 0;
        }
        return await response[parseAs]();
      };
      return { data: await getResponseData(), response };
    }
    let error = await response.text();
    try {
      error = JSON.parse(error);
    } catch {
    }
    return { error, response };
  }
  return {
    request(method, url, init) {
      return coreFetch(url, { ...init, method: method.toUpperCase() });
    },
    /** Call a GET endpoint */
    GET(url, init) {
      return coreFetch(url, { ...init, method: "GET" });
    },
    /** Call a PUT endpoint */
    PUT(url, init) {
      return coreFetch(url, { ...init, method: "PUT" });
    },
    /** Call a POST endpoint */
    POST(url, init) {
      return coreFetch(url, { ...init, method: "POST" });
    },
    /** Call a DELETE endpoint */
    DELETE(url, init) {
      return coreFetch(url, { ...init, method: "DELETE" });
    },
    /** Call a OPTIONS endpoint */
    OPTIONS(url, init) {
      return coreFetch(url, { ...init, method: "OPTIONS" });
    },
    /** Call a HEAD endpoint */
    HEAD(url, init) {
      return coreFetch(url, { ...init, method: "HEAD" });
    },
    /** Call a PATCH endpoint */
    PATCH(url, init) {
      return coreFetch(url, { ...init, method: "PATCH" });
    },
    /** Call a TRACE endpoint */
    TRACE(url, init) {
      return coreFetch(url, { ...init, method: "TRACE" });
    },
    /** Register middleware */
    use(...middleware) {
      for (const m of middleware) {
        if (!m) {
          continue;
        }
        if (typeof m !== "object" || !("onRequest" in m || "onResponse" in m || "onError" in m)) {
          throw new Error("Middleware must be an object with one of `onRequest()`, `onResponse() or `onError()`");
        }
        globalMiddlewares.push(m);
      }
    },
    /** Unregister middleware */
    eject(...middleware) {
      for (const m of middleware) {
        const i = globalMiddlewares.indexOf(m);
        if (i !== -1) {
          globalMiddlewares.splice(i, 1);
        }
      }
    }
  };
}
function serializePrimitiveParam(name, value, options) {
  if (value === void 0 || value === null) {
    return "";
  }
  if (typeof value === "object") {
    throw new Error(
      "Deeply-nested arrays/objects aren\u2019t supported. Provide your own `querySerializer()` to handle these."
    );
  }
  return `${name}=${options?.allowReserved === true ? value : encodeURIComponent(value)}`;
}
function serializeObjectParam(name, value, options) {
  if (!value || typeof value !== "object") {
    return "";
  }
  const values = [];
  const joiner = {
    simple: ",",
    label: ".",
    matrix: ";"
  }[options.style] || "&";
  if (options.style !== "deepObject" && options.explode === false) {
    for (const k in value) {
      values.push(k, options.allowReserved === true ? value[k] : encodeURIComponent(value[k]));
    }
    const final2 = values.join(",");
    switch (options.style) {
      case "form": {
        return `${name}=${final2}`;
      }
      case "label": {
        return `.${final2}`;
      }
      case "matrix": {
        return `;${name}=${final2}`;
      }
      default: {
        return final2;
      }
    }
  }
  for (const k in value) {
    const finalName = options.style === "deepObject" ? `${name}[${k}]` : k;
    values.push(serializePrimitiveParam(finalName, value[k], options));
  }
  const final = values.join(joiner);
  return options.style === "label" || options.style === "matrix" ? `${joiner}${final}` : final;
}
function serializeArrayParam(name, value, options) {
  if (!Array.isArray(value)) {
    return "";
  }
  if (options.explode === false) {
    const joiner2 = { form: ",", spaceDelimited: "%20", pipeDelimited: "|" }[options.style] || ",";
    const final = (options.allowReserved === true ? value : value.map((v) => encodeURIComponent(v))).join(joiner2);
    switch (options.style) {
      case "simple": {
        return final;
      }
      case "label": {
        return `.${final}`;
      }
      case "matrix": {
        return `;${name}=${final}`;
      }
      // case "spaceDelimited":
      // case "pipeDelimited":
      default: {
        return `${name}=${final}`;
      }
    }
  }
  const joiner = { simple: ",", label: ".", matrix: ";" }[options.style] || "&";
  const values = [];
  for (const v of value) {
    if (options.style === "simple" || options.style === "label") {
      values.push(options.allowReserved === true ? v : encodeURIComponent(v));
    } else {
      values.push(serializePrimitiveParam(name, v, options));
    }
  }
  return options.style === "label" || options.style === "matrix" ? `${joiner}${values.join(joiner)}` : values.join(joiner);
}
function createQuerySerializer(options) {
  return function querySerializer(queryParams) {
    const search = [];
    if (queryParams && typeof queryParams === "object") {
      for (const name in queryParams) {
        const value = queryParams[name];
        if (value === void 0 || value === null) {
          continue;
        }
        if (Array.isArray(value)) {
          if (value.length === 0) {
            continue;
          }
          search.push(
            serializeArrayParam(name, value, {
              style: "form",
              explode: true,
              ...options?.array,
              allowReserved: options?.allowReserved || false
            })
          );
          continue;
        }
        if (typeof value === "object") {
          search.push(
            serializeObjectParam(name, value, {
              style: "deepObject",
              explode: true,
              ...options?.object,
              allowReserved: options?.allowReserved || false
            })
          );
          continue;
        }
        search.push(serializePrimitiveParam(name, value, options));
      }
    }
    return search.join("&");
  };
}
function defaultPathSerializer(pathname, pathParams) {
  let nextURL = pathname;
  for (const match of pathname.match(PATH_PARAM_RE) ?? []) {
    let name = match.substring(1, match.length - 1);
    let explode = false;
    let style = "simple";
    if (name.endsWith("*")) {
      explode = true;
      name = name.substring(0, name.length - 1);
    }
    if (name.startsWith(".")) {
      style = "label";
      name = name.substring(1);
    } else if (name.startsWith(";")) {
      style = "matrix";
      name = name.substring(1);
    }
    if (!pathParams || pathParams[name] === void 0 || pathParams[name] === null) {
      continue;
    }
    const value = pathParams[name];
    if (Array.isArray(value)) {
      nextURL = nextURL.replace(match, serializeArrayParam(name, value, { style, explode }));
      continue;
    }
    if (typeof value === "object") {
      nextURL = nextURL.replace(match, serializeObjectParam(name, value, { style, explode }));
      continue;
    }
    if (style === "matrix") {
      nextURL = nextURL.replace(match, `;${serializePrimitiveParam(name, value)}`);
      continue;
    }
    nextURL = nextURL.replace(match, style === "label" ? `.${encodeURIComponent(value)}` : encodeURIComponent(value));
  }
  return nextURL;
}
function defaultBodySerializer(body, headers) {
  if (body instanceof FormData) {
    return body;
  }
  if (headers) {
    const contentType = headers.get instanceof Function ? headers.get("Content-Type") ?? headers.get("content-type") : headers["Content-Type"] ?? headers["content-type"];
    if (contentType === "application/x-www-form-urlencoded") {
      return new URLSearchParams(body).toString();
    }
  }
  return JSON.stringify(body);
}
function createFinalURL(pathname, options) {
  let finalURL = `${options.baseUrl}${pathname}`;
  if (options.params?.path) {
    finalURL = options.pathSerializer(finalURL, options.params.path);
  }
  let search = options.querySerializer(options.params.query ?? {});
  if (search.startsWith("?")) {
    search = search.substring(1);
  }
  if (search) {
    finalURL += `?${search}`;
  }
  return finalURL;
}
function mergeHeaders(...allHeaders) {
  const finalHeaders = new Headers();
  for (const h of allHeaders) {
    if (!h || typeof h !== "object") {
      continue;
    }
    const iterator = h instanceof Headers ? h.entries() : Object.entries(h);
    for (const [k, v] of iterator) {
      if (v === null) {
        finalHeaders.delete(k);
      } else if (Array.isArray(v)) {
        for (const v2 of v) {
          finalHeaders.append(k, v2);
        }
      } else if (v !== void 0) {
        finalHeaders.set(k, v);
      }
    }
  }
  return finalHeaders;
}
function removeTrailingSlash(url) {
  if (url.endsWith("/")) {
    return url.substring(0, url.length - 1);
  }
  return url;
}

// node_modules/@tasker-systems/temper-ts/dist/client.js
function refusingDotSegments(pathname, pathParams) {
  const serialized = defaultPathSerializer(pathname, pathParams);
  for (const segment of serialized.split("/")) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
    }
    if (decoded === "." || decoded === "..") {
      throw new TypeError(`a path value makes ${pathname} into ${serialized}, whose \`${decoded}\` segment would address the parent route`);
    }
  }
  return serialized;
}
function createTemperClient(opts) {
  requireEndpoint(opts.baseUrl, "baseUrl", { allowInsecureHttp: opts.allowInsecureHttp });
  return createClient({
    baseUrl: opts.baseUrl,
    pathSerializer: refusingDotSegments,
    fetch: createAuthedFetch({
      credentials: opts.credentials,
      fetch: opts.fetch
    })
  });
}

// node_modules/@tasker-systems/temper-ts/dist/index.js
var TEMPER_TS_VERSION = "0.0.0";
export {
  BearerToken,
  ClientCredentials,
  TEMPER_TS_VERSION,
  TokenMintError,
  createAuthedFetch,
  createTemperClient,
  isLoopback,
  requireEndpoint
};
