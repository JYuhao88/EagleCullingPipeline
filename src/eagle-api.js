// Eagle Web API V2 defaults to port 41595; allow an override for installations
// configured with a different local port.
const DEFAULT_BASE_URL = `http://127.0.0.1:${process.env.EAGLE_API_PORT || "41595"}/api/v2`;

export class EagleApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "EagleApiError";
    this.status = status;
  }
}

export class EagleApi {
  constructor({ baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetch = fetchImpl;
  }

  async get(path, params = {}) {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\//, "")}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }

    let response;
    try {
      response = await this.fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      throw new EagleApiError(
        `Unable to reach Eagle at ${this.baseUrl}. Is Eagle running? ${error.message}`,
      );
    }

    if (!response.ok) {
      throw new EagleApiError(`Eagle returned HTTP ${response.status}`, response.status);
    }

    const payload = await response.json();
    if (payload.status !== "success") {
      throw new EagleApiError(payload.message || "Eagle returned an error");
    }
    return payload.data;
  }

  async post(path, body = {}) {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\//, "")}`);
    let response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new EagleApiError(`Unable to reach Eagle at ${this.baseUrl}. ${error.message}`);
    }
    if (!response.ok) throw new EagleApiError(`Eagle returned HTTP ${response.status}`, response.status);
    const payload = await response.json();
    if (payload.status !== "success") throw new EagleApiError(payload.message || "Eagle returned an error");
    return payload.data;
  }

  appInfo() {
    return this.get("app/info");
  }

  libraryInfo() {
    return this.get("library/info");
  }

  updateItem(item) {
    return this.post("item/update", item);
  }

  // Official V2 endpoint: itemId, NOT the V1 endpoint's id field.
  // Success is only an API acknowledgement. Callers must verify original
  // hashes, human metadata and derived previews before declaring restoration.
  // Do not automatically retry a lost acknowledgement: Eagle may still be
  // rebuilding the thumbnail after this HTTP client stops observing it.
  async refreshThumbnail(itemId) {
    if (typeof itemId !== "string" || !itemId.trim()) throw new Error("A non-empty Eagle itemId is required");
    try {
      const acknowledgement = await this.post("item/refreshThumbnail", {itemId});
      if (acknowledgement === false) throw new Error("Eagle thumbnail refresh was not acknowledged");
      return acknowledgement;
    } catch (error) {
      error.refreshOutcome = "unknown";
      error.fatal = true;
      throw error;
    }
  }

  async *items({ fields, limit = 500 } = {}) {
    let offset = 0;
    while (true) {
      const page = await this.get("item/get", {
        fields: fields?.join(","),
        offset,
        limit,
      });
      const items = page.data || [];
      yield* items;
      offset += items.length;
      if (items.length === 0 || offset >= page.total) return;
    }
  }
}

export { DEFAULT_BASE_URL };
