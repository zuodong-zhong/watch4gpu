/** @typedef {ReturnType<typeof globalThis.setTimeout> | number} Timer */

/**
 * Poll each node independently, waiting for its request to finish before starting
 * its next delay. A node id keeps its in-flight slot even if its config changes.
 *
 * @template {{ id: string, enabled?: boolean }} Node
 * @template Result
 * @param {{
 *   poll: (node: Node) => Promise<Result>,
 *   onResult: (node: Node, result: Result) => void,
 *   onError: (node: Node, error: unknown) => void,
 *   onActivity?: (activeCount: number) => void,
 *   setTimer?: (callback: () => void, delay: number) => Timer,
 *   clearTimer?: (timer: Timer) => void,
 * }} options
 */
export function createNodePoller(options) {
  /** @typedef {{ node: Node, signature: string, version: number, wanted: boolean, pending: Promise<void> | null, timer: Timer | null }} Entry */
  /** @type {Map<string, Entry>} */
  const entries = new Map();
  const setTimer = options.setTimer ?? globalThis.setTimeout;
  const clearTimer = options.clearTimer ?? globalThis.clearTimeout;
  let intervalMs = 0;
  let stopped = false;

  function reportActivity() {
    if (!stopped) {
      options.onActivity?.([...entries.values()].filter((entry) => entry.wanted && entry.pending).length);
    }
  }

  /** @param {Entry} entry */
  function clearWaiting(entry) {
    if (entry.timer !== null) {
      clearTimer(entry.timer);
      entry.timer = null;
    }
  }

  /** @param {Entry} entry */
  function schedule(entry) {
    clearWaiting(entry);
    if (!stopped && entry.wanted && !entry.pending && intervalMs > 0) {
      entry.timer = setTimer(() => {
        entry.timer = null;
        void collect(entry);
      }, intervalMs);
    }
  }

  /** @param {Entry} entry @returns {Promise<void>} */
  function collect(entry) {
    if (stopped || !entry.wanted) return Promise.resolve();
    if (entry.pending) return entry.pending;
    clearWaiting(entry);
    const { node, version } = entry;
    entry.pending = Promise.resolve()
      .then(async () => {
        if (stopped || !entry.wanted || entry.version !== version) return;
        let result;
        try {
          result = await options.poll(node);
        } catch (error) {
          if (!stopped && entry.wanted && entry.version === version) options.onError(node, error);
          return;
        }
        if (!stopped && entry.wanted && entry.version === version) options.onResult(node, result);
      })
      .finally(() => {
        entry.pending = null;
        if (stopped) return;
        if (!entry.wanted) entries.delete(node.id);
        else if (entry.version !== version) void collect(entry);
        else schedule(entry);
        reportActivity();
      });
    reportActivity();
    return entry.pending;
  }

  return {
    /** @param {readonly Node[]} nodes */
    setNodes(nodes) {
      if (stopped) return;
      const wanted = new Map(nodes.filter((node) => node.enabled !== false).map((node) => [node.id, node]));
      for (const [id, entry] of entries) {
        if (!wanted.has(id)) {
          if (entry.wanted) entry.version += 1;
          entry.wanted = false;
          clearWaiting(entry);
          if (!entry.pending) entries.delete(id);
        }
      }
      for (const [id, node] of wanted) {
        const signature = JSON.stringify(node);
        let entry = entries.get(id);
        if (!entry) {
          entry = { node, signature, version: 0, wanted: true, pending: null, timer: null };
          entries.set(id, entry);
          void collect(entry);
        } else if (!entry.wanted || entry.signature !== signature) {
          entry.node = node;
          entry.signature = signature;
          entry.version += 1;
          entry.wanted = true;
          void collect(entry);
        }
      }
      reportActivity();
    },

    /** @param {number} ms */
    setInterval(ms) {
      if (stopped) return;
      intervalMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
      for (const entry of entries.values()) schedule(entry);
    },

    /** @param {string} [nodeId] @returns {Promise<void>} */
    async refresh(nodeId) {
      if (stopped) return;
      const targets = nodeId === undefined ? [...entries.values()] : [entries.get(nodeId)];
      await Promise.all(targets.filter((entry) => entry?.wanted).map((entry) => collect(/** @type {Entry} */ (entry))));
    },

    stop() {
      stopped = true;
      for (const entry of entries.values()) clearWaiting(entry);
      entries.clear();
    },
  };
}
