/**
 * Client half of dsh-notify.
 *
 * This is a hand-written classic script, not a build artifact. The loader only
 * registers `{ id, factory }`; the factory runs on first use and returns a
 * normal Cordis plugin (`{ inject, apply }`). `id` must stay byte-identical to
 * `package.json`'s `name`, otherwise the host reports the file as loaded
 * without registering anything.
 *
 * Design constraints:
 *
 * - `uiSession.sessionStatus` is the ONLY session-state event source. Subscribing to the
 *   approval or user-question request waterfalls would consume the client
 *   waterfall and make the real approval panel disappear.
 * - Foreground state is event-driven. `document.hasFocus()` is read once at
 *   load; after that, `focus`, `blur`, and `visibilitychange` maintain two
 *   booleans. Polling `hasFocus()` is unreliable on a minimized Windows
 *   window, where it may keep returning true.
 * - Every system notification is silent. There is deliberately no audio
 *   branch anywhere in this file.
 * - Visible text is assigned with `textContent`, never through an HTML string;
 *   session titles are user-controlled.
 */
window.__ModuleLoader__.load({
  id: "dsh-notify",
  factory(require) {
    /** Stable debounce after `running` flips true -> false. */
    const SETTLE_MS = 10_000;
    /** Per-session, per-kind notification gate. */
    const SAME_KIND_GATE_MS = 10_000;
    /** Maximum individual background notifications before one summary. */
    const MAX_NOTIFICATIONS = 5;
    /** How long an in-page card remains before fading out. */
    const CARD_TTL_MS = 8_000;
    /** Maximum simultaneously visible in-page cards. */
    const MAX_CARDS = 3;

    const STACK_ID = "dsh-notify-stack";
    const PERMISSION_REQUESTED_KEY = "dsh-notify.permission-requested";
    const SUMMARY_TAG = "dsh-notify-summary";

    const inject = ["sessions", "uiSession"];

    /**
     * Install the notification worker.
     *
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      if (typeof window === "undefined" || typeof document === "undefined") return;
      if (typeof ctx?.effect !== "function") return;
      if (typeof ctx.get !== "function") return;

      // `uiSession` is an internal service name. If a release renames it, the
      // required inject keeps this plugin parked rather than throwing; the
      // explicit lookup also covers a partially constructed service object.
      const uiSession = ctx.get("uiSession");
      const status = uiSession?.sessionStatus;
      if (
        status === null ||
        typeof status !== "object" ||
        typeof status.getSnapshot !== "function" ||
        typeof status.subscribe !== "function"
      ) {
        return;
      }

      // `sessions` is required by inject. `remote` and `uiWorkspace` are
      // optional: losing either only disables error notifications or the
      // "jump to session" half of a click.
      const sessions = ctx.get("sessions");
      const remote = ctx.get("remote");

      let disposed = false;
      let baselineReady = false;
      /** Previous sessionStatus snapshot, used only for transitions. */
      let previous = new Map();

      // Foreground = visible AND focused. Maintained by events, never polled
      // after this initial read.
      let visible = true;
      let focused = true;
      try {
        visible = document.visibilityState === "visible";
        focused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
      } catch {
        visible = true;
        focused = true;
      }
      let foreground = visible && focused;

      /** sessionId -> timeout id for the completion stability window. */
      const settleTimers = new Map();
      /** card element -> Set<timeout id>, so FIFO eviction and dispose clear them. */
      const cardTimers = new Map();
      /** Live system Notification objects owned by this plugin. */
      const openNotifications = new Set();
      /** `${sessionId}\0${kind}` -> last display timestamp. */
      const gates = new Map();
      /** Pending interaction identities already handled (baseline included). */
      const seenPendingKeys = new Set();

      let systemBurstCount = 0;
      let stack = null;
      let permissionWarned = false;
      let authCleanups = [];
      let disposeStatus = null;
      let disposeReset = null;
      let disposeError = null;

      // ---------------------------------------------------------------------
      // Session state transitions
      // ---------------------------------------------------------------------

      /** Read the authoritative current map, or an empty map on a broken read. */
      function currentStatusMap() {
        try {
          const snapshot = status.getSnapshot();
          return snapshot instanceof Map ? snapshot : new Map();
        } catch {
          return new Map();
        }
      }

      /** Seed the baseline without emitting anything. */
      function syncBaseline() {
        previous = currentStatusMap();
        for (const [sessionId, entry] of previous) {
          const pending = entry?.pendingInteraction;
          if (pending) seenPendingKeys.add(pendingKeyFor(sessionId, pending));
        }
      }

      function onStatusChange() {
        if (disposed || !baselineReady) return;
        const snapshot = currentStatusMap();

        // A removed session cannot complete. Cancel its pending settle timer.
        for (const sessionId of previous.keys()) {
          if (!snapshot.has(sessionId)) cancelSettle(sessionId);
        }

        for (const [sessionId, entry] of snapshot) {
          const prior = previous.get(sessionId);
          const pending = entry?.pendingInteraction;

          if (pending) {
            // Waiting for the user wins over the completion stability window.
            cancelSettle(sessionId);
          } else if (entry?.running === true) {
            // goal next round / queued message: the stable window restarts.
            cancelSettle(sessionId);
          } else if (prior?.running === true && entry?.running === false) {
            scheduleCompletion(sessionId);
          }

          if (pending) {
            const key = pendingKeyFor(sessionId, pending);
            if (!seenPendingKeys.has(key)) {
              seenPendingKeys.add(key);
              emitPending(sessionId, pending);
            }
          }
        }

        previous = snapshot;
      }

      /**
       * @param sessionId - session that just stopped running.
       */
      function scheduleCompletion(sessionId) {
        cancelSettle(sessionId);
        const timer = window.setTimeout(() => {
          if (settleTimers.get(sessionId) !== timer) return;
          settleTimers.delete(sessionId);
          if (disposed) return;

          const current = currentStatusMap().get(sessionId);
          if (
            current === undefined ||
            current.running !== false ||
            current.pendingInteraction != null
          ) {
            return;
          }
          emit("completion", sessionId, "✅ 任务完成");
        }, SETTLE_MS);
        settleTimers.set(sessionId, timer);
      }

      function cancelSettle(sessionId) {
        const timer = settleTimers.get(sessionId);
        if (timer === undefined) return;
        settleTimers.delete(sessionId);
        try {
          window.clearTimeout(timer);
        } catch {
          // A disposed window cannot have a live timer.
        }
      }

      function clearSettleTimers() {
        for (const timer of settleTimers.values()) {
          try {
            window.clearTimeout(timer);
          } catch {
            // Ignore a window that went away during teardown.
          }
        }
        settleTimers.clear();
      }

      function onConnectionReset() {
        if (disposed) return;
        // Reconnect replays a snapshot. Treat the first post-reset frame as a
        // new baseline so a replay cannot produce a burst of old completions.
        clearSettleTimers();
        gates.clear();
        seenPendingKeys.clear();
        baselineReady = false;
        syncBaseline();
        baselineReady = true;
      }

      // ---------------------------------------------------------------------
      // Foreground tracking
      // ---------------------------------------------------------------------

      function setForeground(next) {
        if (disposed || next === foreground) return;
        foreground = next;
        if (next) {
          // A new background burst starts from the next minimization.
          systemBurstCount = 0;
        }
      }

      function onFocus() {
        focused = true;
        setForeground(visible && focused);
      }

      function onBlur() {
        focused = false;
        setForeground(false);
      }

      function onVisibilityChange() {
        let nextVisible = true;
        try {
          nextVisible = document.visibilityState === "visible";
        } catch {
          nextVisible = true;
        }
        visible = nextVisible;
        setForeground(visible && focused);
      }

      // ---------------------------------------------------------------------
      // Notification output
      // ---------------------------------------------------------------------

      /**
       * Emit one notification through the exit selected by the decision table.
       *
       * @param kind - gate class: completion, error, or the pending kind.
       * @param sessionId - owning session.
       * @param body - notification/card body.
       */
      function emit(kind, sessionId, body) {
        if (disposed) return;

        // The foreground completion exit is intentionally the only one that
        // consults `completionUnread`.
        if (kind === "completion" && foreground) {
          const current = currentStatusMap().get(sessionId);
          if (current === undefined || current.completionUnread !== true) return;
        }

        const gateKey = `${sessionId}\u0000${kind}`;
        const now = Date.now();
        const last = gates.get(gateKey);
        if (last !== undefined && now - last < SAME_KIND_GATE_MS) return;

        const title = displayTitle(sessionId);
        let shown = false;

        if (foreground) {
          shown = showCard(title, body, sessionId);
        } else {
          shown = showSystemNotification(sessionId, title, body);
          if (!shown) {
            // Visible degradation when Notification is unsupported, denied,
            // or default. There is no system notification to duplicate, so a
            // card is the only possible fallback. It is created now, never
            // replayed when the page returns to the foreground.
            shown = showCard(title, body, sessionId);
          }
        }

        if (shown) gates.set(gateKey, now);
      }

      function emitPending(sessionId, pending) {
        const kind =
          typeof pending?.kind === "string" && pending.kind !== ""
            ? pending.kind
            : "unknown";
        emit(kind, sessionId, messageFor(kind, pending));
      }

      function onRemoteError(sessionId, message) {
        if (disposed) return;
        let text = "";
        try {
          text = message === undefined || message === null ? "" : String(message).trim();
        } catch {
          text = "";
        }
        emit("error", sessionId, text === "" ? "✕ 出错" : `✕ 出错 · ${text}`);
      }

      function messageFor(kind, pending) {
        if (kind === "approval") {
          const toolName =
            typeof pending?.toolName === "string" ? pending.toolName.trim() : "";
          return toolName === ""
            ? "⏳ 等待审批"
            : `⏳ 等待审批 · ${toolName}`;
        }
        if (kind === "question") return "❓ 在等你回答";
        if (kind === "plan-review") return "📋 计划待你批准";
        return "需要你";
      }

      function pendingKeyFor(sessionId, pending) {
        let key = "";
        try {
          key = pending?.key === undefined || pending?.key === null ? "" : String(pending.key);
        } catch {
          key = "";
        }
        if (key !== "") return `${sessionId}\u0000${key}`;

        // Defensive fallback for a future interaction shape without `key`.
        const kind =
          typeof pending?.kind === "string" && pending.kind !== ""
            ? pending.kind
            : "unknown";
        const toolName =
          typeof pending?.toolName === "string" ? pending.toolName : "";
        return `${sessionId}\u0000${kind}\u0000${toolName}`;
      }

      function displayTitle(sessionId) {
        const title = sessionTitle(sessionId);
        return isSubagent(sessionId) ? `↳ ${title}` : title;
      }

      function sessionTitle(sessionId) {
        try {
          const snapshot = sessions?.list?.getSnapshot?.();
          const title = snapshot?.byId?.[sessionId]?.title;
          if (typeof title === "string" && title.trim() !== "") return title;
        } catch {
          // Fall through to the neutral title.
        }
        return "会话";
      }

      function isSubagent(sessionId) {
        try {
          return (
            typeof sessions?.subagentAddress === "function" &&
            sessions.subagentAddress(sessionId) !== undefined
          );
        } catch {
          return false;
        }
      }

      function jumpToSession(sessionId) {
        focusWindow();
        let workspace;
        try {
          workspace = ctx.get("uiWorkspace");
        } catch {
          workspace = undefined;
        }
        if (workspace === undefined || workspace === null) return;
        if (typeof workspace.openSession !== "function") return;
        try {
          const result = workspace.openSession(sessionId);
          if (result !== null && typeof result === "object" && typeof result.catch === "function") {
            result.catch(() => {});
          }
        } catch {
          // A click must never throw out of the notification handler.
        }
      }

      function focusWindow() {
        try {
          window.focus?.();
        } catch {
          // Some embedded shells refuse programmatic focus; the notification
          // still closes.
        }
      }

      // ---------------------------------------------------------------------
      // System notifications
      // ---------------------------------------------------------------------

      function notificationsSupported() {
        return typeof Notification !== "undefined";
      }

      function notificationsAllowed() {
        try {
          return notificationsSupported() && Notification.permission === "granted";
        } catch {
          return false;
        }
      }

      /**
       * @returns whether a Notification was constructed. Oversized bursts
       * collapse to one summary, closing the individual notifications first,
       * so the notification center never shows a wall of stale entries.
       */
      function showSystemNotification(sessionId, title, body) {
        if (!notificationsAllowed()) return false;

        systemBurstCount += 1;
        if (systemBurstCount > MAX_NOTIFICATIONS) {
          closeAllSystemNotifications();
          try {
            const summary = new Notification(`还有 ${systemBurstCount} 项更新`, {
              body: "点击回到 DeepSeek Harness",
              tag: SUMMARY_TAG,
              silent: true,
            });
            trackNotification(summary);
            summary.onclick = () => {
              focusWindow();
              closeNotification(summary);
            };
            return true;
          } catch {
            return false;
          }
        }

        try {
          const notification = new Notification(title, {
            body,
            tag: `dsh-notify-${sessionId}`,
            silent: true,
          });
          trackNotification(notification);
          notification.onclick = () => {
            jumpToSession(sessionId);
            closeNotification(notification);
          };
          return true;
        } catch {
          return false;
        }
      }

      function trackNotification(notification) {
        openNotifications.add(notification);

        const forget = () => {
          openNotifications.delete(notification);
        };
        notification.onclose = forget;
        notification.onerror = () => {
          forget();
          try {
            notification.close();
          } catch {
            // Ignore a notification the browser already discarded.
          }
        };
      }

      function closeNotification(notification) {
        try {
          notification.close();
        } catch {
          // Ignore a notification the browser already discarded.
        }
        openNotifications.delete(notification);
      }

      function closeAllSystemNotifications() {
        for (const notification of [...openNotifications]) {
          try {
            notification.close();
          } catch {
            // Ignore a notification the browser already discarded.
          }
        }
        openNotifications.clear();
      }

      // ---------------------------------------------------------------------
      // In-page cards
      // ---------------------------------------------------------------------

      function ensureStack() {
        if (stack !== null && stack.parentNode !== null) return stack;

        const existing = document.getElementById(STACK_ID);
        if (existing !== null) {
          stack = existing;
          return stack;
        }
        if (!document.body) return null;

        const host = document.createElement("div");
        host.id = STACK_ID;
        host.style.position = "fixed";
        host.style.right = "16px";
        host.style.bottom = "16px";
        host.style.zIndex = "2147483000";
        host.style.display = "flex";
        host.style.flexDirection = "column";
        host.style.gap = "8px";
        host.style.pointerEvents = "none";
        document.body.appendChild(host);
        stack = host;
        return stack;
      }

      /**
       * @returns whether the card was appended. A missing <body> only means
       * no in-page exit is possible yet; it must not gate future attempts.
       */
      function showCard(title, body, sessionId) {
        if (MAX_CARDS <= 0) return false;
        const host = ensureStack();
        if (host === null) return false;

        while (host.children.length >= MAX_CARDS) {
          const oldest = host.firstElementChild;
          if (oldest === null) break;
          removeCard(oldest);
        }

        const card = document.createElement("div");
        card.setAttribute("data-dsh-notify-card", "");
        card.setAttribute("role", "button");
        card.tabIndex = 0;
        card.style.pointerEvents = "auto";
        card.style.borderRadius = "10px";
        card.style.background = "#26221f";
        card.style.color = "#f5f2ee";
        card.style.boxShadow = "0 6px 24px rgba(0,0,0,.35)";
        card.style.font = "13px/1.5 system-ui";
        card.style.padding = "10px 14px";
        card.style.maxWidth = "360px";
        card.style.boxSizing = "border-box";
        card.style.cursor = "pointer";
        card.style.overflowWrap = "anywhere";
        card.style.transition = "opacity 200ms ease";
        card.style.opacity = "1";

        const titleElement = document.createElement("div");
        titleElement.style.fontWeight = "600";
        titleElement.style.marginBottom = "2px";
        titleElement.textContent = title;

        const bodyElement = document.createElement("div");
        bodyElement.style.opacity = "0.9";
        bodyElement.textContent = body;

        card.appendChild(titleElement);
        card.appendChild(bodyElement);

        const open = () => {
          jumpToSession(sessionId);
          removeCard(card);
        };
        card.addEventListener("click", open);
        card.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
            event.preventDefault();
            open();
          }
        });

        host.appendChild(card);

        const ttlTimer = window.setTimeout(() => {
          forgetCardTimer(card, ttlTimer);
          card.style.opacity = "0";
          const fadeTimer = window.setTimeout(() => {
            forgetCardTimer(card, fadeTimer);
            removeCard(card);
          }, 220);
          trackCardTimer(card, fadeTimer);
        }, CARD_TTL_MS);
        trackCardTimer(card, ttlTimer);
        return true;
      }

      function trackCardTimer(card, timer) {
        let timers = cardTimers.get(card);
        if (timers === undefined) {
          timers = new Set();
          cardTimers.set(card, timers);
        }
        timers.add(timer);
      }

      function forgetCardTimer(card, timer) {
        const timers = cardTimers.get(card);
        if (timers === undefined) return;
        timers.delete(timer);
        if (timers.size === 0) cardTimers.delete(card);
      }

      function removeCard(card) {
        const timers = cardTimers.get(card);
        if (timers !== undefined) {
          for (const timer of timers) {
            try {
              window.clearTimeout(timer);
            } catch {
              // Ignore a window that went away during teardown.
            }
          }
          cardTimers.delete(card);
        }
        if (card.parentNode !== null) card.parentNode.removeChild(card);
      }

      // ---------------------------------------------------------------------
      // Permission
      // ---------------------------------------------------------------------

      function installPermissionRequest() {
        if (!notificationsSupported()) return;

        let permission;
        try {
          permission = Notification.permission;
        } catch {
          return;
        }

        if (permission === "denied") {
          warnPermissionDenied();
          return;
        }
        if (permission !== "default") return;

        let alreadyRequested = false;
        try {
          alreadyRequested =
            window.localStorage.getItem(PERMISSION_REQUESTED_KEY) === "1";
        } catch {
          alreadyRequested = false;
        }
        if (alreadyRequested) return;

        let detach = null;
        const onFirstGesture = () => {
          if (detach !== null) {
            detach();
            detach = null;
          }
          if (disposed) return;
          try {
            window.localStorage.setItem(PERMISSION_REQUESTED_KEY, "1");
          } catch {
            // A storage-less shell cannot remember the request; the in-memory
            // once-listener still prevents a prompt loop for this page load.
          }
          requestPermission();
        };

        detach = () => {
          document.removeEventListener("pointerdown", onFirstGesture, true);
          document.removeEventListener("keydown", onFirstGesture, true);
        };
        authCleanups.push(detach);
        document.addEventListener("pointerdown", onFirstGesture, {
          once: true,
          capture: true,
        });
        document.addEventListener("keydown", onFirstGesture, {
          once: true,
          capture: true,
        });
      }

      function requestPermission() {
        if (
          !notificationsSupported() ||
          typeof Notification.requestPermission !== "function"
        ) {
          return;
        }
        try {
          const result = Notification.requestPermission();
          if (result !== null && typeof result === "object" && typeof result.then === "function") {
            result.then(
              (permission) => handlePermission(permission),
              () => {},
            );
          }
        } catch {
          // Browsers may reject the prompt (for example, outside a user
          // gesture). Notification exit simply remains unavailable; cards work.
        }
      }

      function handlePermission(permission) {
        if (disposed) return;
        if (permission === "denied") warnPermissionDenied();
      }

      function warnPermissionDenied() {
        if (permissionWarned) return;
        permissionWarned = true;
        console.warn(
          "[dsh-notify] 浏览器已拒绝系统通知权限；请到站点设置（地址栏左侧的网站信息 → 通知）改为“允许”。页内卡片不受影响。",
        );
      }

      // ---------------------------------------------------------------------
      // Lifecycle
      // ---------------------------------------------------------------------

      function cleanup() {
        if (disposed) return;
        disposed = true;

        try {
          if (typeof disposeStatus === "function") disposeStatus();
        } catch {
          // Ignore an already torn-down service.
        }
        try {
          if (typeof disposeReset === "function") disposeReset();
        } catch {
          // Ignore an already torn-down context event.
        }
        try {
          if (typeof disposeError === "function") disposeError();
        } catch {
          // Ignore an already torn-down remote event.
        }

        try {
          window.removeEventListener("focus", onFocus);
        } catch {
          // The page may be unloading.
        }
        try {
          window.removeEventListener("blur", onBlur);
        } catch {
          // The page may be unloading.
        }
        try {
          document.removeEventListener("visibilitychange", onVisibilityChange);
        } catch {
          // The page may be unloading.
        }

        for (const detach of authCleanups) {
          try {
            detach();
          } catch {
            // Ignore a listener that was already detached.
          }
        }
        authCleanups = [];

        clearSettleTimers();
        for (const timers of cardTimers.values()) {
          for (const timer of timers) {
            try {
              window.clearTimeout(timer);
            } catch {
              // Ignore a window that went away during teardown.
            }
          }
        }
        cardTimers.clear();
        closeAllSystemNotifications();

        if (stack !== null && stack.parentNode !== null) {
          stack.parentNode.removeChild(stack);
        }
        stack = null;

        previous = new Map();
        gates.clear();
        seenPendingKeys.clear();
      }

      ctx.effect(() => {
        try {
          disposeStatus = status.subscribe(onStatusChange);
        } catch {
          // If even the baseline subscription fails, the service is unusable.
          return;
        }

        if (typeof ctx.on === "function") {
          try {
            disposeReset = ctx.on("connection/reset", onConnectionReset);
          } catch {
            disposeReset = null;
          }
        }

        if (remote !== undefined && remote !== null && typeof remote.$on === "function") {
          try {
            disposeError = remote.$on("api-session/error", onRemoteError);
          } catch {
            disposeError = null;
          }
        }

        window.addEventListener("focus", onFocus);
        window.addEventListener("blur", onBlur);
        document.addEventListener("visibilitychange", onVisibilityChange);
        installPermissionRequest();

        // The first snapshot is baseline only: no completion, no card, no
        // system notification, even if sessions are already waiting.
        baselineReady = false;
        syncBaseline();
        baselineReady = true;

        return cleanup;
      }, "dsh-notify: session notifications");
    }

    return { inject, apply };
  },
});
