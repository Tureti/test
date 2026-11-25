(() => {
  const origFetch = window.fetch.bind(window);

  const readStore = (db, storeName, key) =>
    new Promise((res) => {
      const r = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => res(null);
    });

  const getActiveChat = async () => {
    const id = (localStorage.getItem("TM_useLastOpenedChatID") || "").replace(/^"|"$/g, "");
    if (!id) return null;

    const db = await new Promise((res) => {
      const r = indexedDB.open("keyval-store");
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    });
    if (!db) return null;

    try {
      const storeName = db.objectStoreNames.contains("keyval")
        ? "keyval"
        : db.objectStoreNames[0];
      return (
        (await readStore(db, storeName, `CHAT_${id}`)) ||
        (await readStore(db, storeName, id))
      );
    } finally {
      db.close();
    }
  };

  const extractThinkingAndText = (m) => {
    let thinking = "";
    let text = "";

    const rawThink =
      m?.thinking ??
      m?.thinkingContent ??
      m?.reasoning ??
      m?.reasoning_content ??
      m?.reasoningContent;
    if (typeof rawThink === "string") {
      thinking = rawThink;
    } else if (Array.isArray(rawThink)) {
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

    return { thinking: thinking.trim(), text: text.trim() };
  };

  window.fetch = async (...args) => {
    const [, init] = args;

    if (init && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body);
        if (Array.isArray(body.messages) && /mistral/i.test(body.model || "")) {
          const chat = await getActiveChat();
          const stored = (chat?.messages || [])
            .filter((m) => m.role === "assistant")
            .map(extractThinkingAndText)
            .filter((m) => m.thinking && m.text);

          let injected = 0;
          body.messages = body.messages.map((msg) => {
            if (msg.role === "assistant" && typeof msg.content === "string") {
              const idx = stored.findIndex((s) => s.text === msg.content.trim());
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

          if (injected > 0) {
            console.log(`[Mistral Reasoning] Injected ${injected} turn(s) from IndexedDB.`);
            args[1] = { ...init, body: JSON.stringify(body) };
          }
        }
      } catch {}
    }

    return origFetch(...args);
  };

  console.log("✅ [Mistral Reasoning] IndexedDB extension loaded.");
})();
