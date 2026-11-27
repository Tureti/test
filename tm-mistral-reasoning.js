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

  const extract = ({ content, tool_calls }) => {
    if (!Array.isArray(content)) return null;
    let thinking = "", text = "";
    for (const p of content) {
      if (p?.type === "thinking") {
        thinking += [].concat(p.thinking || p.text || "").map((t) => t?.text ?? t ?? "").join("");
      } else if (p?.type === "text") {
        text += p.text || "";
      }
    }
    const toolId = tool_calls?.[0]?.id;
    thinking = norm(thinking);
    text = norm(text);
    return thinking && (text || toolId) ? { thinking, text, toolId } : null;
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
            if (msg.role !== "assistant" || msg.content?.some?.((p) => p?.type === "thinking")) return msg;
            const i = msg.tool_calls?.length
              ? stored.findIndex((s) => s.toolId && msg.tool_calls.some((t) => t.id === s.toolId))
              : typeof msg.content === "string"
                ? stored.findIndex((s) => !s.toolId && s.text === norm(msg.content))
                : -1;
            if (i === -1) return msg;
            changed = true;
            const block = { type: "thinking", thinking: [{ type: "text", text: stored.splice(i, 1)[0].thinking }] };
            return {
              ...msg,
              content: [
                block,
                ...(typeof msg.content === "string"
                  ? (norm(msg.content) ? [{ type: "text", text: msg.content }] : [])
                  : msg.content || []),
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
