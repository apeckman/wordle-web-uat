// Offline cache for the web game: repeat visits load from the phone, and it works with no internet.
//
// Every launch first asks the site for version.json (written by build_web.py: a version plus the
// SHA-256 of each of the game's files), giving up after CHECK_TIMEOUT or at once when the browser
// knows it's offline. A new version is downloaded in full and checked against those hashes before
// it replaces the saved one, so a launch either runs the new release or, if anything goes wrong
// (no signal, a half-finished GitHub deploy), the last complete one. Nobody needs to refresh twice.
//
// pygbag's Python runtime (~11 MB from its CDN) is saved separately and kept across releases:
// files at a given CDN address never change.
//
// UAT and prod share the origin apeckman.github.io, and the browser's caches are per origin, so
// every cache name starts with this site's folder and each site only ever touches its own.
//
// Kill switch: if this ever misbehaves, publish a sw.js that deletes caches starting with PREFIX
// and calls self.registration.unregister(). Browsers re-check sw.js on every launch (the page
// registers it with updateViaCache "none"), so that reaches everyone on their next visit.

const SCOPE = new URL(self.registration.scope).pathname;  // "/wordle-web/" or "/wordle-web-uat/"
const PREFIX = "wordle " + SCOPE + " ";
const META = PREFIX + "meta";        // which release is saved
const RUNTIME = PREFIX + "runtime";  // pygbag's runtime and packages
const RUNTIME_HOSTS = ["pygame-web.github.io"];
const CHECK_TIMEOUT = 1500;  // ms to wait for version.json before using the saved copy
const INSTALL_TIMEOUT = 30000;

const here = (file) => new URL(file, self.registration.scope).href;
const ACTIVE_KEY = here("sw-meta/active");

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
    // First visit: the page loaded before this worker existed, so save the release now.
    event.waitUntil(self.clients.claim().then(() => update(10000)).catch(() => {}));
});

self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET" || !request.url.startsWith("http")) return;
    const url = new URL(request.url);
    if (request.mode === "navigate") {
        if (url.origin === location.origin && (url.pathname === SCOPE || url.pathname === SCOPE + "index.html")) {
            event.respondWith(launch().then((page) => page || fetch(request)).catch(() => fetch(request)));
        }
        return;
    }
    event.respondWith(resource(request, url).catch(() => fetch(request)));
});

// The page sends what it downloaded on the first visit (before this worker could see it).
self.addEventListener("message", (event) => {
    const urls = (event.data && event.data.cache) || [];
    event.waitUntil(Promise.all(urls.map(async (address) => {
        try {
            if (RUNTIME_HOSTS.includes(new URL(address).host)) await runtime(address);
        } catch (e) { /* best effort */ }
    })));
});

async function readActive() {
    const saved = await (await caches.open(META)).match(ACTIVE_KEY);
    return saved ? saved.json() : null;
}

// The page for this launch: the newest release we can get, else the saved one, else null.
async function launch() {
    const active = (await update(CHECK_TIMEOUT)) || (await readActive());
    if (!active) return null;
    return (await caches.open(PREFIX + active.version)).match(here("index.html"));
}

// Save the latest release if it's new. Returns the release now saved (null if none is).
async function update(timeout) {
    const active = await readActive();
    const latest = await latestVersion(timeout);
    if (!latest || (active && latest.version === active.version)) return active;
    return (await install(latest)) ? latest : active;
}

async function latestVersion(timeout) {
    if (self.navigator && self.navigator.onLine === false) return null;
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), timeout);
    try {
        const response = await fetch(here("version.json"), { cache: "no-store", signal: stop.signal });
        if (!response.ok) return null;
        const release = await response.json();
        return release.version && release.files ? release : null;
    } catch (e) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Download a release, check every file's hash, and only then make it the saved one.
async function install(release) {
    const name = PREFIX + release.version;
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), INSTALL_TIMEOUT);
    try {
        const files = await Promise.all(Object.entries(release.files).map(async ([file, hash]) => {
            const response = await fetch(here(file), { cache: "no-cache", signal: stop.signal });
            if (!response.ok) throw new Error(file + ": " + response.status);
            const body = await response.arrayBuffer();
            if ((await sha256(body)) !== hash) throw new Error(file + ": not the published version yet");
            return [file, body, response.headers.get("Content-Type") || ""];
        }));
        const cache = await caches.open(name);
        for (const [file, body, type] of files) {
            await cache.put(here(file), new Response(body, { headers: { "Content-Type": type } }));
        }
        await (await caches.open(META)).put(ACTIVE_KEY, new Response(JSON.stringify(release)));
        for (const key of await caches.keys()) {  // older releases of this site only
            if (key.startsWith(PREFIX) && key !== name && key !== META && key !== RUNTIME) await caches.delete(key);
        }
        return true;
    } catch (e) {
        console.warn("Wordle offline cache: keeping the saved version.", e);
        await caches.delete(name);
        return false;
    } finally {
        clearTimeout(timer);
    }
}

async function sha256(buffer) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function resource(request, url) {
    if (url.origin === location.origin && url.pathname.startsWith(SCOPE)) {
        const file = url.pathname.slice(SCOPE.length);
        const active = await readActive();
        if (active && file in active.files) {
            const saved = await (await caches.open(PREFIX + active.version)).match(here(file));
            if (saved) return saved;
        }
        return fetch(request);  // version.json, sw.js and anything else stays live
    }
    if (RUNTIME_HOSTS.includes(url.host)) return runtime(request.url);
    return fetch(request);
}

// Cache-first for the CDN. Fetched in CORS mode so a failed download is never saved.
async function runtime(address) {
    const cache = await caches.open(RUNTIME);
    const saved = await cache.match(address);
    if (saved) return saved;
    const response = await fetch(address, { mode: "cors", credentials: "omit" });
    if (response.ok) await cache.put(address, response.clone());
    return response;
}
