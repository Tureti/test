(() => {
  const STORAGE_KEY = "tm_mistral_reasoning_cache_v1";
  const MAX_ENTRIES = 100;
  const origFetch = window.fetch.bind(window);

  // Load persisted cache so reasoning survives page reloads
  let cache = {};
  try {
    cache = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    cache = {};
  }

  const saveCache = (answerText, entry) => {
    const key = answerText.trim();
    if (!key || !entry.thinking) return;
    cache[key] = entry;
    const keys = Object.keys(cache);
    if (keys.length > MAX_ENTRIES) {
      delete cache[keys[0]];
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
    } catch {}
  };

  window.fetch = async (...args) => {
    const [resource, init] = args;
    let bodyObj = null;

    // 1. Inspect outgoing request & re-inject cached reasoning for Mistral models
    if (init && typeof init.body === "string") {
      try {
        const parsed = JSON.parse(init.body);
        if (
          Array.isArray(parsed.messages) &&
          typeof parsed.model === "string" &&
          /mistral/i.test(parsed.model)
        ) {
          bodyObj = parsed;
          let injectedCount = 0;

          parsed.messages = parsed.messages.map((msg) => {
            if (msg.role === "assistant" && typeof msg.content === "string") {
              const hit = cache[msg.content.trim()];
              if (hit) {
                injectedCount++;
                if (hit.format === "mistral_chunks") {
                  return {
                    ...msg,
                    content: [
                      {
                        type: "thinking",
                        thinking: [{ type: "text", text: hit.thinking }],
                      },
                      { type: "text", text: msg.content },
                    ],
                  };
                }
                if (hit.format === "reasoning_content") {
                  return { ...msg, reasoning_content: hit.thinking };
                }
              }
            }
            return msg;
          });

          if (injectedCount > 0) {
            console.log(
              `[Mistral Reasoning] Re-injected reasoning into ${injectedCount} assistant turn(s).`
            );
            args[1] = { ...init, body: JSON.stringify(parsed) };
          }
        }
      } catch {}
    }

    const response = await origFetch(...args);

    // 2. Capture incoming reasoning from the cloned stream without blocking TypingMind
    if (bodyObj && response.ok && response.body) {
      const clone = response.clone();
      const contentType = clone.headers.get("content-type") || "";

      if (contentType.includes("text/event-stream")) {
        (async () => {
          const reader = clone.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let format = null;
          let thinking = "";
          let answer = "";

          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;
                const dataStr = trimmed.slice(5).trim();
                if (!dataStr || dataStr === "[DONE]") continue;

                try {
                  const chunk = JSON.parse(dataStr);
                  const delta = chunk?.choices?.[0]?.delta;
                  if (!delta) continue;

                  // Official Mistral API format: content array of ThinkChunk + TextChunk
                  if (Array.isArray(delta.content)) {
                    for (const part of delta.content) {
                      if (part?.type === "thinking" && Array.isArray(part.thinking)) {
                        format = "mistral_chunks";
                        for (const t of part.thinking) {
                          if (typeof t?.text === "string") thinking += t.text;
                        }
                      } else if (part?.type === "text" && typeof part.text === "string") {
                        answer += part.text;
                      }
                    }
                  } else if (typeof delta.content === "string") {
                    answer += delta.content;
                  }

                  // OpenAI-compatible format (vLLM / SGLang / Ollama)
                  if (typeof delta.reasoning_content === "string") {
                    if (!format) format = "reasoning_content";
                    thinking += delta.reasoning_content;
                  }
                } catch {}
              }
            }

            if (format && thinking && answer.trim()) {
              saveCache(answer, { format, thinking });
              console.log(
                `[Mistral Reasoning] Cached ${thinking.length} chars (${format}).`
              );
            }
          } catch {}
        })();
      }
    }

    return response;
  };

  console.log("✅ [Mistral Reasoning] Extension loaded.");
})();
