import { localSetting } from './local-config.js';
// Eagle Web API V2 defaults to port 41595; allow an override for installations
// configured with a different local port.
const DEFAULT_BASE_URL = `http://127.0.0.1:${process.env.EAGLE_API_PORT || "41595"}/api/v2`;

export function normalizeLibraryPath(value) {
  return String(value || "").normalize("NFC").replace(/[\\/]+$/, "");
}

export class EagleApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "EagleApiError";
    this.status = status;
  }
}

export class EagleApi {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    apiVersion = "auto",
    expectedLibraryPath = localSetting("EAGLE_EXPECTED_LIBRARY"),
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetch = fetchImpl;
    if (!["auto", 1, 2].includes(apiVersion))
      throw new Error("Invalid Eagle API version");
    this.apiVersion = apiVersion === "auto" ? null : apiVersion;
    this.rootUrl = this.baseUrl.replace(/\/api(?:\/v2)?$/, "");
    this.expectedLibraryPath = expectedLibraryPath;
    this.endpointVersions = new Map();
    if (this.apiVersion)
      this.baseUrl = `${this.rootUrl}/api${this.apiVersion === 2 ? "/v2" : ""}`;
  }

  async detect() {
    if (this.apiVersion) return this.apiVersion;
    this.detection ||= (async () => {
      try {
        await this.request("GET", "library/info");
        this.apiVersion = 2;
      } catch (error) {
        // Only an unsupported read endpoint permits fallback. Never retry a
        // write, timeout, application failure or authentication failure.
        if (error.status !== 404) throw error;
        this.baseUrl = `${this.rootUrl}/api`;
        this.apiVersion = 1;
        await this.request("GET", "library/info");
      }
      return this.apiVersion;
    })();
    return this.detection;
  }

  async assertLibrary(expected = this.expectedLibraryPath) {
    const library = await this.libraryInfo();
    if (expected && normalizeLibraryPath(library.path) !== normalizeLibraryPath(expected))
      throw new Error(
        `Eagle library mismatch: expected ${expected}, got ${library.path}`,
      );
    return library;
  }

  async itemInfo(id) {
    return this.get("item/info", { id });
  }

  async get(path, params = {}) {
    await this.detect();
    if (this.expectedLibraryPath && path !== "library/info")
      await this.assertLibrary();
    const data = await this.endpointRequest("GET", path, params);
    return data;
  }

  async post(path, body = {}) {
    await this.detect();
    if (this.expectedLibraryPath) await this.assertLibrary();
    return this.endpointRequest("POST", path, body);
  }

  async endpointRequest(method, path, values) {
    const version = this.endpointVersions.get(path) || this.apiVersion;
    try {
      return await this.request(method, path, values, version);
    } catch (error) {
      // These mixed-version Eagle builds reject unsupported endpoints before
      // applying mutations. An explicit 404 is the only safe write retry.
      if (version !== 2 || error.status !== 404 || !["item/info", "item/update"].includes(path)) throw error;
      this.endpointVersions.set(path, 1);
      return this.request(method, path, values, 1);
    }
  }

  async request(method, path, values = {}, version = this.apiVersion) {
    const baseUrl = version ? `${this.rootUrl}/api${version === 2 ? "/v2" : ""}` : this.baseUrl;
    const url = new URL(`${baseUrl}/${path.replace(/^\//, "")}`);
    // V1 ignores numeric zero when clearing ratings.
    if (version === 1 && path === "item/update" && values.star === 0) values = { ...values, star: "0" };
    if (method === "GET")
      for (const [key, value] of Object.entries(values)) {
        if (value !== undefined && value !== null)
          url.searchParams.set(key, value);
      }
    let response;
    try {
      response = await this.fetch(url, {
        ...(method === "POST"
          ? {
              method,
              headers: { "content-type": "application/json" },
              body: JSON.stringify(values),
            }
          : {}),
        signal: AbortSignal.timeout(method === "POST" ? 30_000 : 10_000),
      });
    } catch (error) {
      throw new EagleApiError(
        `Unable to reach Eagle at ${this.baseUrl}. ${error.message}`,
      );
    }
    if (!response.ok)
      throw new EagleApiError(
        `Eagle returned HTTP ${response.status}`,
        response.status,
      );
    const payload = await response.json();
    if (payload.status !== "success")
      throw new EagleApiError(
        payload.message ||
          (typeof payload.data === "string"
            ? payload.data
            : "Eagle returned an error"),
        Number(payload.code) === 404 ? 404 : undefined,
      );
    return payload.data;
  }

  appInfo() {
    return this.get("app/info");
  }
  async libraryInfo() {
    const value = await this.get("library/info");
    return value?.library?.path
      ? {
          ...value,
          path: value.library.path,
          name: value.library.name || value.name,
        }
      : value;
  }

  updateItem(item) {
    // Official /api/item/update supports optional star (ratings) alongside tags.
    // https://api.eagle.cool/item/update.md; callers must preserve existing ratings.
    return this.post("item/update", item);
  }

  moveToTrash(itemIds) {
    return this.post("item/moveToTrash", this.apiVersion === 1 ? { itemIds } : { itemIds });
  }

  // Official V2 endpoint: itemId, NOT the V1 endpoint's id field.
  // Success is only an API acknowledgement. Callers must verify original
  // hashes, human metadata and derived previews before declaring restoration.
  // Do not automatically retry a lost acknowledgement: Eagle may still be
  // rebuilding the thumbnail after this HTTP client stops observing it.
  async refreshThumbnail(itemId) {
    if (typeof itemId !== "string" || !itemId.trim())
      throw new Error("A non-empty Eagle itemId is required");
    try {
      await this.detect();
      const acknowledgement = await this.post(
        "item/refreshThumbnail",
        this.apiVersion === 1 ? { id: itemId } : { itemId },
      );
      if (acknowledgement === false)
        throw new Error("Eagle thumbnail refresh was not acknowledged");
      return acknowledgement;
    } catch (error) {
      error.refreshOutcome = "unknown";
      error.fatal = true;
      throw error;
    }
  }

  async *items({ fields, limit = 500 } = {}) {
    await this.detect();
    let offset = 0;
    let fieldList = fields?.join(",");
    while (true) {
      const path = this.apiVersion === 1 ? "item/list" : "item/get";
      let page;
      try {
        page = await this.get(path, { fields: fieldList, offset, limit });
      } catch (error) {
        // Some Eagle 4 builds answer HTTP 500 to any `fields` filter.
        if (!fieldList || error.status !== 500) throw error;
        fieldList = undefined;
        page = await this.get(path, { offset, limit });
      }
      const items = Array.isArray(page) ? page : page.data || [];
      yield* items;
      offset += items.length;
      if (
        items.length === 0 ||
        (Array.isArray(page) ? items.length < limit : offset >= page.total)
      )
        return;
    }
  }
}

export { DEFAULT_BASE_URL };
