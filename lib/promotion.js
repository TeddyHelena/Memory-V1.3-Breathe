export function selectPromotable(candidates, alreadyToday, options = {}) {
    const cap = options.cap ?? 3;
    const maxSim = options.maxSimilarity ?? 0.9;
    const out = [];
    for (const c of candidates) {
        if (out.length + alreadyToday >= cap)
            break;
        if (!c.source_session || !c.source_session.trim())
            continue;
        if ((c.similarity ?? 0) > maxSim)
            continue;
        out.push(c.id);
    }
    return out;
}
