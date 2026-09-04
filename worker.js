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
      try {
        const submitRes = await fetch("https://api.anakin.io/v1/url-scraper", {
          method: "POST",
          headers,
          body: JSON.stringify({
            url: fetchUrl,
            country: "us",
            useBrowser: true,
            formats: [format]
          })
        });

        if (!submitRes.ok) return "";
        const jobData = await submitRes.json();
        const jobId = jobData.jobId || jobData.id;
        if (!jobId) return "";

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
              break;
            }
          }
        }
        return "";
      } catch (e) {
        return "";
      }
    };

    // =========================================================================
    // ENDPOINT 1: /api-events -> Raspa o Calendário Oficial 2026 CT da WSL
    // =========================================================================
    if (url.pathname === '/api-events') {
      try {
        const markdown = await scrapeSingleUrl('https://www.worldsurfleague.com/events/2026/ct?all=1');

        if (!markdown) {
          throw new Error("Não foi possível carregar a agenda oficial da WSL.");
        }

        const eventRegex = /\[([^\]]+)\]\(https:\/\/www\.worldsurfleague\.com\/events\/2026\/ct\/(\d+)\/([^/]+)\/(?:main|results)\)/gi;
        const eventsFound = [];
        const seenIds = new Set();
        let match;

        while ((match = eventRegex.exec(markdown)) !== null) {
          let rawName = match[1]
            .replace(/\\\n/g, ' ')
            .replace(/\n/g, ' ')
            .replace(/\s*Presented By.*/gi, '') // Remove o texto do patrocinador
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

        // Garante a presença de Philippines Pro caso não tenha link direto
        if (!seenIds.has('444') && markdown.toLowerCase().includes('philippines pro')) {
          eventsFound.splice(10, 0, {
            id: "philippines-pro-444",
            wslUrl: "https://www.worldsurfleague.com/events/2026/ct/444/philippines-pro/results",
            name: "Philippines Pro",
            eventId: "444",
            slug: "philippines-pro"
          });
        }

        // Formata os nomes com numeração limpa (1. Nome da Etapa)
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
        return new Response(JSON.stringify({
          sucesso: false,
          mensagem: "Falha ao buscar calendário: " + err.message
        }), { headers: corsHeaders });
      }
    }

    // =========================================================================
    // ENDPOINT 2: /api-wsl -> Raspa os Confrontos e Resultados da Etapa Selecionada
    // =========================================================================
    if (url.pathname === '/api-wsl') {
      let targetURL = url.searchParams.get('url');

      if (!targetURL) {
        return new Response(JSON.stringify({ 
          sucesso: false, 
          mensagem: "Parâmetro 'url' é obrigatório." 
        }), { status: 400, headers: corsHeaders });
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

        if (!mainMarkdown) {
          throw new Error("Não foi possível obter os dados da etapa na WSL.");
        }

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
          const bad = [
            'heat', 'round', 'replay', 'details', 'final', 'quarterfinal', 'semifinal',
            'pick', 'picks', 'fan', 'watch', 'result', 'results', 'clear', 'apply',
            'show', 'spoiler', 'vs', 'http', 'wave', 'fiji', 'pro', 'event', 'product',
            'attribute', 'value', 'description', 'image', 'tourism', 'airways', 'resort',
            'island', 'surf', 'surfline', 'corona', 'cero', 'status', 'rank',
            'congratulations', 'presented', 'completed'
          ];
          const l = s.toLowerCase();
          return bad.some(b => l.includes(b));
        };

        const heatsFound = [];

        for (let i = 0; i < cleanLines.length; i++) {
          if (isScore(cleanLines[i])) {
            let p1 = null;
            for (let b = 1; b <= 4 && (i - b) >= 0; b++) {
              if (!isBadName(cleanLines[i - b])) {
                p1 = cleanLines[i - b];
                break;
              }
            }

            for (let f = 1; f <= 6 && (i + f) < cleanLines.length; f++) {
              if (isScore(cleanLines[i + f])) {
                let p2 = null;
                for (let k = i + 1; k < i + f; k++) {
                  if (!isBadName(cleanLines[k])) {
                    p2 = cleanLines[k];
                    break;
                  }
                }

                if (p1 && p2 && p1 !== p2) {
                  const score1 = parseFloat(cleanLines[i]);
                  const score2 = parseFloat(cleanLines[i + f]);
                  let winner = null;
                  if (score1 > score2) winner = p1;
                  else if (score2 > score1) winner = p2;

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
        return new Response(JSON.stringify({
          sucesso: false,
          mensagem: "Falha na extração de baterias: " + err.message
        }), { headers: corsHeaders });
      }
    }

    return env.ASSETS.fetch(request);
  }
};