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

    const scrapeSingleUrl = async (fetchUrl, format = "markdown") => {
      const submitRes = await fetch("https://api.anakin.io/v1/url-scraper", {
        method: "POST",
        headers,
        body: JSON.stringify({ url: fetchUrl, country: "us", useBrowser: true, formats: [format] })
      });

      if (!submitRes.ok) {
        const errText = await submitRes.text();
        throw new Error(`Anakin.io HTTP ${submitRes.status}: ${errText}`);
      }

      const jobData = await submitRes.json();
      const jobId = jobData.jobId || jobData.id;
      if (!jobId) throw new Error("Anakin.io não gerou o ID do job.");

      let attempts = 0;
      while (attempts < 20) {
        await new Promise(r => setTimeout(r, 1000));
        attempts++;

        const pollRes = await fetch(`https://api.anakin.io/v1/url-scraper/${jobId}`, { headers });
        if (pollRes.ok) {
          const result = await pollRes.json();
          if (result.status === "completed") {
            return result.markdown || result.html || (result.data ? result.data.markdown || result.data.html : "");
          } else if (result.status === "failed") {
            throw new Error("Falha no servidor do Anakin ao ler a página.");
          }
        }
      }
      throw new Error("Timeout: A WSL demorou mais de 20s na validação do Cloudflare.");
    };

    // =========================================================================
    // ENDPOINT 1: Calendário Oficial CT 2026 (/api-events)
    // =========================================================================
    if (url.pathname === '/api-events') {
      try {
        const markdown = await scrapeSingleUrl('https://www.worldsurfleague.com/events/2026/ct?all=1', 'markdown');
        if (!markdown) throw new Error("A página do calendário veio vazia.");

        const eventRegex = /\[([^\]]+)\]\(https:\/\/www\.worldsurfleague\.com\/events\/2026\/ct\/(\d+)\/([^/]+)\/(?:main|results)\)/gi;
        const eventsFound = [];
        const seenIds = new Set();
        let match;

        while ((match = eventRegex.exec(markdown)) !== null) {
          let rawName = match[1]
            .replace(/\\\n/g, ' ')
            .replace(/\n/g, ' ')
            .replace(/\s*Presented By.*/gi, '')
            .trim();
          
          const eventId = match[2];
          const slug = match[3];

          if (!seenIds.has(eventId)) {
            seenIds.add(eventId);
            eventsFound.push({
              id: `${slug}-${eventId}`,
              wslUrl: `https://www.worldsurfleague.com/events/2026/ct/${eventId}/${slug}/results`,
              name: rawName,
              eventId: eventId,
              slug: slug
            });
          }
        }

        // Inclusão dinâmica do Philippines Pro caso esteja sem link no markdown oficial
        if (!seenIds.has('444') && markdown.toLowerCase().includes('philippines pro')) {
          eventsFound.splice(10, 0, {
            id: "philippines-pro-444",
            wslUrl: "https://www.worldsurfleague.com/events/2026/ct/444/philippines-pro/results",
            name: "Philippines Pro",
            eventId: "444",
            slug: "philippines-pro"
          });
        }

        const eventosFormatados = eventsFound.map((ev, idx) => ({
          ...ev,
          name: `${idx + 1}. ${ev.name}`
        }));

        return new Response(JSON.stringify({
          sucesso: true,
          quantidade: eventosFormatados.length,
          eventos: eventosFormatados
        }), { headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({ sucesso: false, mensagem: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // =========================================================================
    // ENDPOINT 2: Leitor de Baterias (/api-wsl) - Suporta Eventos Passados e Futuros
    // =========================================================================
    if (url.pathname === '/api-wsl') {
      let targetURL = url.searchParams.get('url');
      if (!targetURL) return new Response(JSON.stringify({ sucesso: false, mensagem: "Parâmetro 'url' obrigatório." }), { status: 400, headers: corsHeaders });

      const catParam = url.searchParams.get('cat') || 'masculino';
      const catId = catParam === 'feminino' ? '2' : '1';
      
      if (!targetURL.endsWith('/results') && !targetURL.includes('/results?')) {
        targetURL = targetURL.replace(/\/main\/?$/, '') + '/results';
      }

      const baseUrl = targetURL.split('?')[0];
      const targetCatURL = `${baseUrl}?eventCatId=${catId}`;

      try {
        const fullMarkdown = await scrapeSingleUrl(targetCatURL, 'markdown');
        if (!fullMarkdown) throw new Error("Conteúdo da etapa veio vazio.");

        // Função de extração por bloco isolado de bateria (Heat X)
        const parseHeatBlock = (blockText) => {
          let text = blockText
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/https?:\/\/\S+/g, '')
            .replace(/Make heat picks|\*Fan picks|Details|Replay|Watch [^\n]+/gi, '')
            .replace(/Winner Adv[^\n]*/gi, '')
            .replace(/No waves yet|No waves|\d+\s*waves/gi, '')
            .replace(/Results are hidden[^\n]*/gi, '')
            .replace(/Show results|Hide results/gi, '')
            .replace(/\r\n|\r/g, '\n');

          const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

          const isScoreNum = (s) => /^\d{1,2}(\.\d{1,2})?$/.test(s) && parseFloat(s) <= 20.0;
          const isJunkLine = (s) => {
            if (!s || s.length < 2 || s.length > 40) return true;
            const l = s.toLowerCase();
            if (/^heat\s*\d+/i.test(l)) return true;
            if (l === '––' || l === '-' || l === '–') return true;
            const bad = ['winner', 'adv.', 'advancing', 'picks', 'fan', 'details', 'replay', 'watch', 'results', 'spoilers', 'show', 'hide', 'wave', 'waves', 'dawn patrol', 'call', 'upcoming', 'completed', 'champions', 'analyzer', 'draw', 'main', 'popup', 'clear', 'apply', 'selections', 'heats'];
            return bad.some(b => l === b || l.startsWith(b + ' '));
          };

          const scores = [];
          const surferCandidates = [];

          for (const line of lines) {
            if (isScoreNum(line)) {
              scores.push(parseFloat(line));
            } else if (!isJunkLine(line)) {
              surferCandidates.push(line);
            }
          }

          // Filtra duplicatas entre nome curto (Ex: L. Thompson) e nome completo (Ex: Luke Thompson)
          const uniqueNames = [];
          for (const name of surferCandidates) {
            const isDuplicate = uniqueNames.some(existing => {
              if (existing.toLowerCase() === name.toLowerCase()) return true;
              const lastN = name.split(' ').pop().toLowerCase();
              const lastE = existing.split(' ').pop().toLowerCase();
              return lastN === lastE && name.length < existing.length;
            });

            if (!isDuplicate) {
              const shortIdx = uniqueNames.findIndex(existing => {
                const lastN = name.split(' ').pop().toLowerCase();
                const lastE = existing.split(' ').pop().toLowerCase();
                return lastN === lastE && name.length > existing.length;
              });

              if (shortIdx !== -1) uniqueNames[shortIdx] = name;
              else uniqueNames.push(name);
            }
          }

          if (uniqueNames.length < 2) return null;

          const p1 = uniqueNames[0];
          const p2 = uniqueNames[1];
          let score1 = null;
          let score2 = null;
          let winner = null;

          if (scores.length >= 2) {
            score1 = scores[0];
            score2 = scores[1];
            if (score1 > score2) winner = p1;
            else if (score2 > score1) winner = p2;
          }

          return { p1, p2, score1, score2, winner };
        };

        // Divide o Markdown em blocos por "Heat X"
        const heatBlocks = fullMarkdown.split(/(?:^|\n)(?=Heat\s+\d+\b)/i);
        const heatsFound = [];

        for (const block of heatBlocks) {
          if (!/^Heat\s+\d+/i.test(block.trim())) continue;
          const parsed = parseHeatBlock(block);
          if (parsed) heatsFound.push(parsed);
        }

        // Deduplicação de baterias
        const unicos = [];
        const keys = new Set();
        heatsFound.forEach(h => {
          const k = `${h.p1}-${h.p2}`;
          const kRev = `${h.p2}-${h.p1}`;
          if (!keys.has(k) && !keys.has(kRev)) {
            keys.add(k);
            unicos.push(h);
          }
        });

        return new Response(JSON.stringify({
          sucesso: true,
          quantidade: unicos.length,
          baterias: unicos
        }), { headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({ sucesso: false, mensagem: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response(JSON.stringify({ sucesso: false, mensagem: "Rota não encontrada." }), { status: 404, headers: corsHeaders });
  }
};