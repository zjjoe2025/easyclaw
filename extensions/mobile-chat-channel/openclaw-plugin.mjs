import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { MobileSyncEngine, RelayTransport, RELAY_MAX_CLIENT_BYTES, RELAY_MAX_CLIENT_MB } from "./dist/index.mjs";

const MIME_BY_EXT = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
    ".json": "application/json", ".xml": "application/xml",
    ".zip": "application/zip", ".gz": "application/gzip",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".mp4": "video/mp4", ".webm": "video/webm",
};

// Shared relay transport — one WebSocket for all paired phones
let relayTransport = null;

// Map of pairingId -> MobileSyncEngine (supports multiple paired phones)
const syncEngines = new Map();
// Map of pairingId -> { mobileDeviceId, staleSince } (pairings where mobile has unpaired)
const stalePairings = new Map();
let pluginApi = null;

/** Find the sync engine that owns a given `to` address (e.g. "mobile:{pairingId}"). */
function resolveEngine(to) {
    if (!to) {
        // Fallback: return first engine if only one exists
        if (syncEngines.size === 1) return syncEngines.values().next().value;
        return null;
    }
    // `to` is "mobile:{pairingId}" — extract the pairingId and look up directly
    const id = to.startsWith("mobile:") ? to.slice(7) : to;
    return syncEngines.get(id) || null;
}

function maybeStopTransport() {
    if (syncEngines.size === 0 && relayTransport) {
        relayTransport.disconnect();
        relayTransport = null;
    }
}

const plugin = {
    id: "mobile-chat-channel",
    name: "ChatClaw Channel",
    description: "Bridges local OpenClaw with ChatClaw mobile app via Relay",
    configSchema: {
        safeParse(value) {
            if (value === undefined) return { success: true, data: undefined };
            if (!value || typeof value !== "object" || Array.isArray(value))
                return { success: false, error: { issues: [{ path: [], message: "expected config object" }] } };
            return { success: true, data: value };
        },
        jsonSchema: { type: "object", additionalProperties: false, properties: {} },
    },

    register(api) {
        pluginApi = api;

        api.registerChannel({
            plugin: {
                id: "mobile",
                meta: {
                    id: "mobile",
                    label: "ChatClaw",
                    selectionLabel: "ChatClaw",
                    docsPath: "/channels/mobile",
                    blurb: "Chat with your agent on the go from your phone via ChatClaw.",
                    aliases: ["app"],
                },
                capabilities: {
                    chatTypes: ["direct"],
                    media: true,
                    blockStreaming: true,
                },
                config: {
                    listAccountIds: () => (syncEngines.size > 0 || stalePairings.size > 0) ? ["default"] : [],
                    resolveAccount: (_cfg, accountId) => {
                        if (accountId === "default" && (syncEngines.size > 0 || stalePairings.size > 0)) {
                            return { id: "default", name: "ChatClaw" };
                        }
                        return null;
                    },
                    describeAccount: (account) => {
                        const hasEngines = syncEngines.size > 0;
                        const transportConnected = relayTransport ? relayTransport.isConnected() : false;
                        return {
                            accountId: account?.id ?? "default",
                            name: "ChatClaw",
                            configured: hasEngines || stalePairings.size > 0,
                            running: hasEngines && transportConnected,
                        };
                    },
                },
                status: {
                    buildAccountSnapshot: ({ account }) => {
                        const hasEngines = syncEngines.size > 0;
                        const transportConnected = relayTransport ? relayTransport.isConnected() : false;
                        return {
                            accountId: account?.id ?? "default",
                            name: "ChatClaw",
                            configured: hasEngines || stalePairings.size > 0,
                            running: hasEngines && transportConnected,
                            dmPolicy: "pairing",
                        };
                    },
                },
                messaging: {
                    targetResolver: {
                        looksLikeId: (raw) => {
                            const trimmed = (raw || "").trim();
                            if (!trimmed) return false;
                            // Accept "mobile:<uuid>" or bare UUID
                            if (/^mobile:/i.test(trimmed)) return true;
                            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return true;
                            return false;
                        },
                        hint: "mobile:<pairingId>",
                    },
                },
                outbound: {
                    deliveryMode: "gateway",
                    textChunkLimit: 2048,
                    async sendText(ctx) {
                        const engine = resolveEngine(ctx.to);
                        if (engine) {
                            engine.queueOutbound(ctx.to, { type: 'text', text: ctx.text });
                        }
                        return { channel: "mobile", messageId: randomUUID(), chatId: ctx.to ?? "mobile" };
                    },
                    async sendMedia(ctx) {
                        const engine = resolveEngine(ctx.to);
                        if (!engine) {
                            return { channel: "mobile", messageId: randomUUID(), chatId: ctx.to ?? "mobile" };
                        }
                        try {
                            const filePath = ctx.mediaUrl;
                            const buf = await readFile(filePath);
                            if (buf.length > RELAY_MAX_CLIENT_BYTES) {
                                const sizeMB = (buf.length / (1024 * 1024)).toFixed(1);
                                console.error(`[MobileChat Plugin] File too large (${sizeMB} MB), skipping send`);
                                engine.queueOutbound(ctx.to, { type: 'text', text: `[File too large: ${sizeMB} MB, limit is ${RELAY_MAX_CLIENT_MB} MB]` });
                                return { channel: "mobile", messageId: randomUUID(), chatId: ctx.to ?? "mobile" };
                            }
                            const ext = extname(filePath).toLowerCase();
                            const mimeType = MIME_BY_EXT[ext] || "application/octet-stream";
                            const isImage = mimeType.startsWith("image/");
                            const b64 = buf.toString("base64");
                            engine.queueOutbound(ctx.to, {
                                type: isImage ? "image" : "file",
                                data: b64,
                                mimeType,
                                text: ctx.text || "",
                                fileName: basename(filePath),
                            });
                        } catch (err) {
                            console.error("[MobileChat Plugin] Failed to read media file:", err);
                            engine.queueOutbound(ctx.to, { type: 'text', text: ctx.text || '[File]' });
                        }
                        return { channel: "mobile", messageId: randomUUID(), chatId: ctx.to ?? "mobile" };
                    },
                },
            },
        });

        // Forward tool events to paired mobile devices via plugin hooks.
        // Hooks are global — filter by sessionKey to only push to mobile sessions.
        // Disabled: relay server bandwidth impact unknown — enable after load testing.
        const ENABLE_TOOL_STATUS_FORWARDING = false;
        api.on("before_tool_call", (_event, ctx) => {
            if (!ENABLE_TOOL_STATUS_FORWARDING) return;
            const sk = ctx.sessionKey;
            if (!sk) return;
            for (const engine of syncEngines.values()) {
                if (engine.activeSessionKeys.has(sk)) {
                    engine.sendToolStatus(ctx.toolName, "start");
                }
            }
        });
        api.on("after_tool_call", (_event, ctx) => {
            if (!ENABLE_TOOL_STATUS_FORWARDING) return;
            const sk = ctx.sessionKey;
            if (!sk) return;
            for (const engine of syncEngines.values()) {
                if (engine.activeSessionKeys.has(sk)) {
                    engine.sendToolStatus(ctx.toolName, "result");
                }
            }
        });

        // Start or update a sync engine for a specific paired phone
        api.registerGatewayMethod("mobile_chat_start_sync", async ({ params, respond }) => {
            const { pairingId, accessToken, relayUrl, desktopDeviceId, mobileDeviceId } = params;
            const engineKey = pairingId || "default";
            console.log(`[MobileChat Plugin] mobile_chat_start_sync. pairingId=${engineKey}, relayUrl=${relayUrl}`);

            try {
                // Ensure shared transport exists
                if (!relayTransport) {
                    relayTransport = new RelayTransport();
                    relayTransport.start(relayUrl, accessToken, engineKey);
                } else {
                    // Join this pairing on the existing transport
                    relayTransport.joinPairing(engineKey, accessToken).catch(err => {
                        console.error(`[MobileChat Plugin] Failed to join pairing ${engineKey}:`, err);
                    });
                }

                const existing = syncEngines.get(engineKey);
                if (existing) {
                    console.log(`[MobileChat Plugin] SyncEngine already exists for ${engineKey}`);
                } else {
                    const engine = new MobileSyncEngine(
                        pluginApi,
                        relayTransport,
                        engineKey,
                        desktopDeviceId,
                        mobileDeviceId || "default",
                    );
                    engine.onUnpaired = () => {
                        console.log(`[MobileChat Plugin] Mobile unpaired pairingId=${engineKey}. Marking stale.`);
                        engine.stop();
                        syncEngines.delete(engineKey);
                        stalePairings.set(engineKey, {
                            mobileDeviceId: engine.mobileDeviceId,
                            staleSince: Date.now(),
                        });
                        relayTransport?.leavePairing(engineKey);
                        maybeStopTransport();
                    };
                    await engine.start();
                    syncEngines.set(engineKey, engine);
                    console.log(`[MobileChat Plugin] SyncEngine created for ${engineKey}. Total engines: ${syncEngines.size}`);
                }
                respond(true, { success: true });
            } catch (err) {
                console.error("[MobileChat Plugin] Failed to start SyncEngine:", err);
                respond(false, { error: String(err) });
            }
        });

        // Query device-level presence status for all paired phones
        api.registerGatewayMethod("mobile_chat_device_status", async ({ params, respond }) => {
            const devices = {};
            for (const [pairingId, engine] of syncEngines) {
                // Key by pairingId so each pairing has its own status entry
                devices[pairingId] = {
                    relayConnected: engine.isRelayConnected,
                    mobileOnline: engine.mobileOnline,
                };
            }
            // Include stale pairings (mobile has unpaired)
            for (const [pairingId, info] of stalePairings) {
                devices[pairingId] = {
                    relayConnected: false,
                    mobileOnline: false,
                    stale: true,
                    staleSince: info.staleSince,
                };
            }
            respond(true, { devices });
        });

        // Register DB-persisted stale pairings so the channel stays visible after restart
        api.registerGatewayMethod("mobile_chat_register_stale", async ({ params, respond }) => {
            const { pairings } = params || {};
            if (Array.isArray(pairings)) {
                for (const p of pairings) {
                    if (p.pairingId && !syncEngines.has(p.pairingId) && !stalePairings.has(p.pairingId)) {
                        stalePairings.set(p.pairingId, {
                            mobileDeviceId: p.mobileDeviceId || "unknown",
                            staleSince: p.staleSince || Date.now(),
                        });
                    }
                }
                console.log(`[MobileChat Plugin] Registered ${pairings.length} stale pairing(s). Total stale: ${stalePairings.size}`);
            }
            respond(true, { success: true });
        });

        // Stop sync engine(s). If pairingId given, stop that one; otherwise stop all.
        api.registerGatewayMethod("mobile_chat_stop_sync", async ({ params, respond }) => {
            const { pairingId } = params || {};

            if (pairingId) {
                const engine = syncEngines.get(pairingId);
                if (engine) {
                    engine.sendUnpairAndStop();
                    syncEngines.delete(pairingId);
                    relayTransport?.leavePairing(pairingId);
                    console.log(`[MobileChat Plugin] SyncEngine unpaired+stopped for ${pairingId}. Remaining: ${syncEngines.size}`);
                    maybeStopTransport();
                }
                // Also clean up stale tracking if this was a stale cleanup
                stalePairings.delete(pairingId);
            } else {
                // Unpair and stop all engines
                for (const [key, engine] of syncEngines) {
                    engine.sendUnpairAndStop();
                }
                syncEngines.clear();
                stalePairings.clear();
                if (relayTransport) {
                    relayTransport.disconnect();
                    relayTransport = null;
                }
                console.log("[MobileChat Plugin] All SyncEngines unpaired+stopped.");
            }
            respond(true, { success: true });
        });
    },
};

export default plugin;
