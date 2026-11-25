(() => {
  const VERSION = "v2";
  const origFetch = window.fetch.bind(window);

  const readStore = (db, store, key) =>
    new Promise((res) => {
      const r = db.transaction(store, "readonly").objectStore(store).get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => res(null);
    });

  const getActiveChat = async () => {
    const hashId = (location.hash.match(/chat=([^&]+)/) || [])[1];
    const lsId = (localStorage.getItem("TM_useLastOpenedChatID") || "").replace(/^"|"$/g, "");
    const id = hashId || lsId;
    if (!id) return { id: null, chat: null };

    const db = await new Promise((res) => {
      const r = indexedDB.open("keyval-store");
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    });
    if (!db) return { id, chat: null };

    try {
      const store = db.objectStoreNames.contains("keyval") ? "keyval" : db.objectStoreNames[0];
      const chat = (await readStore(db, store, `CHAT_${id}`)) || (await readStore(db, store, id));
      return { id, chat };
    } finally {
      db.close();
    }
  };

  const norm = (s) => (s || "").replace(/\r\n/g, "\n").trim();

  const extract = (m) => {
    let thinking = "";
    let text = "";

    const rawThink =
      m?.thinking ?? m?.thinkingContent ?? m?.reasoning ?? m?.reasoning_content ?? m?.reasoningContent;
    if (typeof rawThink === "string") thinking = rawThink;
    else if (Array.isArray(rawThink)) {
      thinking = rawThink.map((t) => (typeof t === "string" ? t : t?.text || "")).join("");
    }

    if (typeof m?.content === "string") {
      const match = m.content.match(/<think([\s\S]*?)<\/think>\s*([\s\S]*)/i);
      if (match) {
        thinking = thinking || match[1];
        text = match[2];
      } else {
        text = m.content;
      }
    } else if (Array.isArray(m?.content)) {
      for (const p of m.content) {
        if (p?.type === "thinking") {
          thinking +=
            typeof p.thinking === "string"
              ? p.thinking
              : Array.isArray(p.thinking)
                ? p.thinking.map((t) => t?.text || "").join("")
                : p.text || "";
        } else if (p?.type === "text" && typeof p.text === "string") {
          text += p.text;
        }
      }
    }

    return { thinking: norm(thinking), text: norm(text) };
  };

  window.fetch = async (...args) => {
    const [resource, init] = args;
    const url = String(resource?.url ?? resource ?? "");

    if (/api\.mistral\.ai/i.test(url) && typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body);
        if (Array.isArray(body.messages)) {
          const { id, chat } = await getActiveChat();
          const assistantMsgs = (chat?.messages || []).filter((m) => m.role === "assistant");
          const stored = assistantMsgs.map(extract).filter((m) => m.thinking && m.text);

          let injected = 0;
          body.messages = body.messages.map((msg) => {
            if (msg.role === "assistant" && typeof msg.content === "string") {
              const target = norm(msg.content);
              const idx = stored.findIndex(
                (s) => s.text === target || (target.length > 40 && s.text.startsWith(target.slice(0, 80)))
              );
              if (idx !== -1) {
                const [hit] = stored.splice(idx, 1);
                injected++;
                return {
                  ...msg,
                  content: [
                    { type: "thinking", thinking: [{ type: "text", text: hit.thinking }] },
                    { type: "text", text: msg.content },
                  ],
                };
              }
            }
            return msg;
          });

          console.log(`[Mistral Reasoning ${VERSION}]`, {
            model: body.model,
            chatId: id,
            assistantInDB: assistantMsgs.length,
            withThinking: injected + stored.length,
            injected,
            sampleKeys: assistantMsgs[0] ? Object.keys(assistantMsgs[0]) : [],
          });

          if (injected > 0) {
            args[1] = { ...init, body: JSON.stringify(body) };
          }
        }
      } catch (err) {
        console.error(`[Mistral Reasoning ${VERSION}] Error:`, err);
      }
    }

    return origFetch(...args);
  };

  console.log(`✅ [Mistral Reasoning ${VERSION}] Loaded.`);
})();
