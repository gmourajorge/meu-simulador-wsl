export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const headers = {
      "X-API-Key": env.ANAKIN_API_KEY,
      "Content-Type": "application/json"
    };

    // Função de raspagem unificada (Aumentado de 25s para 40s de tolerância)
    const scrapeSingleUrl = async (fetchUrl, format = "markdown") => {
      const submitRes = await fetch("https://api.anakin.io/v1/url-scraper", {
        method: "POST",
        headers,
        body: JSON.stringify({ url: fetchUrl, country: "us", useBrowser: true, formats: [format] })
      });

      if (!submitRes.ok) {
        const errText = await submitRes.text();
        throw new Error(`Anakin.io Recusou (HTTP ${submitRes.status}): ${errText}`);
      }

      const jobData = await submitRes.json();
      const jobId = jobData.jobId || jobData.id;
      if (!jobId) throw new Error("Anakin.io falhou ao gerar o ID do Job.");

      let attempts = 0;
      // AUMENTO DO TEMPO DE ESPERA PARA 40 TENTATIVAS (40 Segundos)
      while (attempts < 40) {
        await new Promise(r => setTimeout(r, 1000));
        attempts++;

        const pollRes = await fetch(`https://api.anakin.io/v1/url-scraper/${jobId}`, { headers });
        if (pollRes.ok) {
          const result = await pollRes.json();
          if (result.status === "completed") {
            return result.markdown || result.html || (result.data ? result.data.markdown || result.data.html : "");
          } else if (result.status === "failed") {
            throw new Error("Anakin.io falhou ao processar a página no servidor de destino.");
          }
        }
      }
      throw new Error("Timeout: A WSL demorou muito na tela de proteção. O Anakin aguardou por 40 segundos e abortou.");
    };

    // =========================================================================
    // 1. Calendário Oficial (/api-events) - EXCLUSIVO VIA ANAKIN
    // =========================================================================
    if (url.pathname === '/api-events') {
      try {
        const content = await scrapeSingleUrl('https://www.worldsurfleague.com/events/2026/ct?all=1', 'html');

        if (!content) throw new Error("A página retornou completamente vazia via Anakin.");

        // Regex flexível que varre o HTML atrás dos links das etapas
        const eventRegex = /\/events\/2026\/ct\/(\d+)\/([^/'"?\s>#]+)/gi;
        const eventsFound = [];
        const seenIds = new Set();
        let match;

        while ((match = eventRegex.exec(content)) !== null) {
          const eventId = match[1];
          const slug = match[2];

          if (!seenIds.has(eventId) && !['main', 'results', 'watch', 'standings'].includes(slug)) {
            seenIds.add(eventId);
            const formattedName = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

            eventsFound.push({
              id: `${slug}-${eventId}`,
              wslUrl: `https://www.worldsurfleague.com/events/2026/ct/${eventId}/${slug}/results`,
              name: `${eventsFound.length + 1}. ${formattedName}`,
              eventId: eventId,
              slug: slug
            });
          }
        }

        if (eventsFound.length === 0) {
          throw new Error("Acesso realizado via Anakin, mas não foram encontrados links de etapas CT no HTML retornado pela WSL.");
        }

        return new Response(JSON.stringify({ sucesso: true, quantidade: eventsFound.length, eventos: eventsFound }), { headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({ sucesso: false, mensagem: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // =========================================================================
    // 2. Resultados da Etapa (/api-wsl) - EXCLUSIVO VIA ANAKIN
    // =========================================================================
    if (url.pathname === '/api-wsl') {
      let targetURL = url.searchParams.get('url');

      if (!targetURL) {
        return new Response(JSON.stringify({ sucesso: false, mensagem: "Parâmetro 'url' é obrigatório." }), { status: 400, headers: corsHeaders });
      }

      const catParam = url.searchParams.get('cat') || 'masculino';
      const catId = catParam === 'feminino' ? '2' : '1';

      if (!targetURL.endsWith('/results') && !targetURL.includes('/results?')) {
        targetURL = targetURL.replace(/\/main\/?$/, '') + '/results';
      }

      const baseUrl = targetURL.split('?')[0];
      const targetCatURL = `${baseUrl}?eventCatId=${catId}`;

      try {
        const mainMarkdown = await scrapeSingleUrl(targetCatURL);
        if (!mainMarkdown) throw new Error("A página da etapa retornou vazia.");

        const roundIds = [...new Set([...mainMarkdown.matchAll(/roundId=(\d+)/g)].map(m => m[1]))];

        let extraMarkdowns = [];
        if (roundIds.length > 0) {
          const roundUrls = roundIds.map(rid => `${baseUrl}?eventCatId=${catId}&roundId=${rid}`);
          extraMarkdowns = await Promise.all(roundUrls.map(u => scrapeSingleUrl(u)));
        }

        const fullMarkdown = [mainMarkdown, ...extraMarkdowns].join("\n\n");

        const cleanLines = fullMarkdown
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/\d+\s*waves/gi, '')
          .replace(/\d{1,2}\.\d{1,2}\s*\+\s*\d{1,2}\.\d{1,2}/g, '')
          .replace(/Make heat picks|\*Fan picks|Details|Replay|Watch [^\n]+/gi, '')
          .replace(/\r\n|\r/g, '\n')
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0);

        const isScore = (s) => /^\d{1,2}\.\d{2}$/.test(s) && parseFloat(s) <= 20.0;
        const isBadName = (s) => {
          if (!s || s.length < 2 || s.length > 35 || /\d/.test(s)) return true;
          const bad = ['heat', 'round', 'replay', 'details', 'final', 'quarterfinal', 'semifinal', 'pick', 'picks', 'fan', 'watch', 'result', 'results', 'clear', 'apply', 'show', 'spoiler', 'vs', 'http', 'wave', 'fiji', 'pro', 'event', 'product', 'attribute', 'value', 'description', 'image', 'tourism', 'airways', 'resort', 'island', 'surf', 'surfline', 'corona', 'cero', 'status', 'rank', 'congratulations', 'presented', 'completed'];
          return bad.some(b => s.toLowerCase().includes(b));
        };

        const heatsFound = [];

        for (let i = 0; i < cleanLines.length; i++) {
          if (isScore(cleanLines[i])) {
            let p1 = null;
            for (let b = 1; b <= 4 && (i - b) >= 0; b++) {
              if (!isBadName(cleanLines[i - b])) { p1 = cleanLines[i - b]; break; }
            }

            for (let f = 1; f <= 6 && (i + f) < cleanLines.length; f++) {
              if (isScore(cleanLines[i + f])) {
                let p2 = null;
                for (let k = i + 1; k < i + f; k++) {
                  if (!isBadName(cleanLines[k])) { p2 = cleanLines[k]; break; }
                }

                if (p1 && p2 && p1 !== p2) {
                  const score1 = parseFloat(cleanLines[i]);
                  const score2 = parseFloat(cleanLines[i + f]);
                  let winner = null;
                  if (score1 > score2) winner = p1; else if (score2 > score1) winner = p2;
                  heatsFound.push({ p1, p2, score1, score2, winner });
                  i = i + f;
                  break;
                }
              }
            }
          }
        }

        const unicos = [];
        const keys = new Set();
        heatsFound.forEach(h => {
          const k = `${h.p1}-${h.p2}`;
          const kRev = `${h.p2}-${h.p1}`;
          if (!keys.has(k) && !keys.has(kRev)) {
            keys.add(k); unicos.push(h);
          }
        });

        return new Response(JSON.stringify({ sucesso: true, quantidade: unicos.length, baterias: unicos }), { headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({ sucesso: false, mensagem: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response(JSON.stringify({ sucesso: false, mensagem: "Rota não encontrada." }), { status: 404, headers: corsHeaders });
  }
};