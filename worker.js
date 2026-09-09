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
    // 1. Calendário (/api-events)
    // =========================================================================
    if (url.pathname === '/api-events') {
      try {
        const content = await scrapeSingleUrl('https://www.worldsurfleague.com/events/2026/ct?all=1', 'html');
        if (!content) throw new Error("A página do calendário veio vazia.");

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

        if (eventsFound.length === 0) throw new Error("Nenhum link de etapa CT localizado.");
        return new Response(JSON.stringify({ sucesso: true, quantidade: eventsFound.length, eventos: eventsFound }), { headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ sucesso: false, mensagem: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // =========================================================================
    // 2. Resultados Dinâmicos (/api-wsl) - STATE MACHINE COM COORDENADAS
    // =========================================================================
    if (url.pathname === '/api-wsl') {
      let targetURL = url.searchParams.get('url');
      if (!targetURL) return new Response(JSON.stringify({ sucesso: false, mensagem: "Parâmetro 'url' obrigatório." }), { status: 400, headers: corsHeaders });

      const catParam = url.searchParams.get('cat') || 'masculino';
      const catId = catParam === 'feminino' ? '2' : '1';
      targetURL = targetURL.replace(/\/main\/?$/, '') + '/results';
      const targetCatURL = `${targetURL.split('?')[0]}?eventCatId=${catId}`;

      try {
        const rawContent = await scrapeSingleUrl(targetCatURL, 'markdown');
        if (!rawContent) throw new Error("Conteúdo da etapa veio vazio.");

        const cleanLines = rawContent
          .replace(/<[^>]+>/g, '\n')
          .replace(/\|/g, '\n')
          .replace(/[*_#`~]/g, '')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/\r\n|\r/g, '\n')
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0);

        const isScore = (s) => /^\d{1,2}(\.\d{1,2})?$/.test(s) && parseFloat(s) <= 20.0 && parseFloat(s) >= 0;
        
        const isJunkLine = (s) => {
          if (!s || s.length < 2 || s.length > 40) return true;
          const l = s.toLowerCase();
          if (/^heat\s*\d+/i.test(l)) return true;
          if (/^r[1-9]\s*heat\s*\d+/i.test(l)) return true;
          if (/^qf\s*heat\s*\d+/i.test(l)) return true;
          if (/^sf\s*heat\s*\d+/i.test(l)) return true;
          if (/^final/i.test(l)) return true;
          if (l.includes('waves') || l.includes('wave')) return true;
          if (l.includes('+')) return true;
          if (l === '––' || l === '-' || l === '–') return true;
          const bad = ['winner', 'adv.', 'advancing', 'picks', 'fan', 'details', 'replay', 'watch', 'results', 'spoilers', 'show', 'hide', 'dawn patrol', 'call', 'upcoming', 'completed', 'champions', 'analyzer', 'draw', 'main', 'popup', 'clear', 'apply', 'selections', 'heats', 'pts', 'points', 'total', 'seed', 'event', 'tourism', 'airways', 'resort', 'surfline'];
          return bad.some(b => l === b || l.startsWith(b + ' '));
        };

        const heatsMasculino = [];
        const heatsFeminino = [];
        let activeCategory = 'masculino';

        // Estado do Analisador
        let currentP1 = null, currentS1 = null, currentP2 = null, currentS2 = null;
        let activeRound = 'r1', activeHeatIdx = 0;
        let heatMeta = { round: 'r1', heatIdx: 0 };

        const processHeat = () => {
           if (currentP1 && currentP2) {
               let winner = null;
               if (currentS1 !== null && currentS2 !== null) {
                   if (currentS1 > currentS2) winner = currentP1;
                   else if (currentS2 > currentS1) winner = currentP2;
               }
               const heatObj = { 
                 p1: currentP1, p2: currentP2, 
                 score1: currentS1, score2: currentS2, 
                 winner, 
                 round: heatMeta.round, heatIdx: heatMeta.heatIdx 
               };
               if (activeCategory === 'masculino') heatsMasculino.push(heatObj);
               else heatsFeminino.push(heatObj);
           }
           currentP1 = null; currentS1 = null; currentP2 = null; currentS2 = null;
        };

        for (let i = 0; i < cleanLines.length; i++) {
          const line = cleanLines[i];
          const lineLower = line.toLowerCase();
          
          if (lineLower.includes("women's") || lineLower.includes("womens")) activeCategory = 'feminino';

          // Detecta a Coordenada Exata (Fase e Número da Bateria)
          let m;
          if (lineLower === 'final' || lineLower === 'grand final') {
              activeRound = 'final'; activeHeatIdx = 0;
          } else if ((m = lineLower.match(/^qf\s*heat\s*(\d+)/))) {
              activeRound = 'qf'; activeHeatIdx = parseInt(m[1]) - 1;
          } else if ((m = lineLower.match(/^sf\s*heat\s*(\d+)/))) {
              activeRound = 'sf'; activeHeatIdx = parseInt(m[1]) - 1;
          } else if ((m = lineLower.match(/^r(\d+)\s*heat\s*(\d+)/))) {
              activeRound = 'r' + m[1]; activeHeatIdx = parseInt(m[2]) - 1;
          } else if ((m = lineLower.match(/^heat\s*(\d+)/))) {
              activeRound = 'r1'; activeHeatIdx = parseInt(m[1]) - 1;
          }

          if (isScore(line)) {
              if (currentP1 && currentS1 === null) currentS1 = parseFloat(line);
              else if (currentP2 && currentS2 === null) currentS2 = parseFloat(line);
          } else if (!isJunkLine(line)) {
              let isDuplicate = false;
              if (currentP1 && currentS1 === null && lineLower.endsWith(currentP1.split(' ').pop().toLowerCase()) && line.length > currentP1.length) {
                  currentP1 = line; isDuplicate = true;
              } else if (currentP2 && currentS2 === null && lineLower.endsWith(currentP2.split(' ').pop().toLowerCase()) && line.length > currentP2.length) {
                  currentP2 = line; isDuplicate = true;
              }

              if (!isDuplicate) {
                  if (!currentP1) {
                      currentP1 = line;
                      heatMeta = { round: activeRound, heatIdx: activeHeatIdx }; // Congela a coordenada
                  } else if (!currentP2) {
                      currentP2 = line;
                  } else {
                      processHeat(); // Salva bateria concluída e inicia a nova
                      currentP1 = line;
                      heatMeta = { round: activeRound, heatIdx: activeHeatIdx };
                  }
              }
          }
        }
        processHeat(); // Garante o salvamento da última bateria lida

        const deduplicate = (arr) => {
            const unicosMap = new Map();
            arr.forEach(h => {
              if (h.p1.toLowerCase().includes('seed') || h.p2.toLowerCase().includes('seed')) return;
              const k = `${h.round}-${h.heatIdx}`; // Agrupa exatamente pela coordenada!
              if (!unicosMap.has(k)) {
                  unicosMap.set(k, h);
              } else if (unicosMap.get(k).score1 === null && h.score1 !== null) {
                  unicosMap.set(k, h); // Substitui se achou uma versão com nota
              }
            });
            return Array.from(unicosMap.values());
        };

        const finalMasculino = deduplicate(heatsMasculino);
        const finalFeminino = deduplicate(heatsFeminino);

        let bateriasResponse = catParam === 'feminino' ? finalFeminino : finalMasculino;
        if (bateriasResponse.length === 0) bateriasResponse = (catParam === 'feminino') ? finalMasculino.slice(-23) : finalMasculino;

        return new Response(JSON.stringify({ sucesso: true, quantidade: bateriasResponse.length, baterias: bateriasResponse }), { headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({ sucesso: false, mensagem: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response(JSON.stringify({ sucesso: false, mensagem: "Rota não encontrada." }), { status: 404, headers: corsHeaders });
  }
};