(() => {
  const origFetch = window.fetch.bind(window);
  const norm = (s) => (s || "").replace(/\r\n/g, "\n").trim();
  const req = (r) =>
    new Promise((res) => {
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => res(null);
    });

  const getChat = async () => {
    const id =
      (location.hash.match(/chat=([^&]+)/) || [])[1] ||
      (localStorage.getItem("TM_useLastOpenedChatID") || "").replace(/^"|"$/g, "");
    const db = id ? await req(indexedDB.open("keyval-store")) : null;
    if (!db) return null;
    const get = (k) => req(db.transaction("keyval", "readonly").objectStore("keyval").get(k));
    try {
      return (await get(`CHAT_${id}`)) || (await get(id));
    } finally {
      db.close();
    }
  };

  const extract = ({ content }) => {
    if (!Array.isArray(content)) return null;
    let thinking = "", text = "";
    for (const p of content) {
      if (p?.type === "thinking") {
        thinking += [].concat(p.thinking || p.text || "").map((t) => t?.text ?? t ?? "").join("");
      } else if (p?.type === "text") {
        text += p.text || "";
      }
    }
    thinking = norm(thinking);
    text = norm(text);
    return thinking && text ? { thinking, text } : null;
  };

  window.fetch = async (...args) => {
    const [resource, init] = args;
    if (/api\.mistral\.ai/i.test(resource?.url ?? resource ?? "") && typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body);
        const chat = Array.isArray(body.messages) ? await getChat() : null;
        const stored = (chat?.messages || []).filter((m) => m?.role === "assistant").map(extract).filter(Boolean);

        if (stored.length) {
          let changed = false;
          body.messages = body.messages.map((msg) => {
            if (msg.role !== "assistant" || typeof msg.content !== "string") return msg;
            const i = stored.findIndex((s) => s.text === norm(msg.content));
            if (i === -1) return msg;
            changed = true;
            return {
              ...msg,
              content: [
                { type: "thinking", thinking: [{ type: "text", text: stored.splice(i, 1)[0].thinking }] },
                { type: "text", text: msg.content },
              ],
            };
          });
          if (changed) args[1] = { ...init, body: JSON.stringify(body) };
        }
      } catch {}
    }
    return origFetch(...args);
  };
})();
