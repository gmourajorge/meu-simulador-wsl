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
        return new Response(JSON.stringify({ sucesso: false, mensagem: err.message }), { status: 200, headers: corsHeaders });
      }
    }

    // =========================================================================
    // 2. Resultados Dinâmicos (/api-wsl) - ISOLAMENTO DE GÊNERO VIA statEventId
    // =========================================================================
    if (url.pathname === '/api-wsl') {
      let targetURL = url.searchParams.get('url');
      if (!targetURL) return new Response(JSON.stringify({ sucesso: false, mensagem: "Parâmetro 'url' obrigatório." }), { status: 400, headers: corsHeaders });

      const catParam = url.searchParams.get('cat') || 'masculino';
      const cleanBase = targetURL.replace(/\/(main|results)\/?$/, '');
      let resultsURL = `${cleanBase}/results`;

      const isReal404 = (content) => {
        if (!content) return true;
        const lower = content.toLowerCase();
        return lower.includes('404 wipeout') || lower.includes('# 404');
      };

      try {
        let rawContent = await scrapeSingleUrl(resultsURL, 'markdown');

        if (isReal404(rawContent)) {
          return new Response(JSON.stringify({ 
            sucesso: false, 
            mensagem: "A WSL ainda não disponibilizou o chaveamento oficial desta etapa." 
          }), { status: 200, headers: corsHeaders });
        }

        // --- NAVEGAÇÃO INTELIGENTE DE GÊNERO ---
        // Identifica o ID único da categoria solicitada para evitar mistura de dados
        let targetStatId = null;
        if (catParam === 'feminino') {
            const match = rawContent.match(/\[Women's Heats[^\]]*\]\([^)]*statEventId=(\d+)[^)]*\)/i);
            if (match) targetStatId = match[1];
        } else {
            const match = rawContent.match(/\[Men's Heats[^\]]*\]\([^)]*statEventId=(\d+)[^)]*\)/i);
            if (match) targetStatId = match[1];
        }

        // Se encontrou o ID da categoria correta, recarrega a página forçando a URL exata
        if (targetStatId) {
            resultsURL = `${cleanBase}/results?statEventId=${targetStatId}`;
            rawContent = await scrapeSingleUrl(resultsURL, 'markdown');
        }

        // --- EXTRAÇÃO DAS ABAS (Rounds, Brackets) ---
        const roundIds = [...new Set([...rawContent.matchAll(/roundId=(\d+)/g)].map(m => m[1]))];
        let extraContents = [];
        
        if (roundIds.length > 0) {
            // Repassa o statEventId para as abas filhas para garantir que o gênero não seja resetado!
            const statParam = targetStatId ? `&statEventId=${targetStatId}` : '';
            const roundUrls = roundIds.slice(0, 3).map(rid => `${cleanBase}/results?roundId=${rid}${statParam}`);
            
            for (const u of roundUrls) {
                try {
                    const md = await scrapeSingleUrl(u, 'markdown');
                    extraContents.push(md);
                } catch (err) {
                    console.log(`Falha ao carregar aba extra (${u}): ${err.message}`);
                }
            }
        }
        
        const fullMarkdown = [rawContent, ...extraContents].join('\n\n');

        const cleanLines = fullMarkdown
          .replace(/<[^>]+>/g, '\n')
          .replace(/\|/g, '\n')
          .replace(/make heat picks.*?(fan picks|\*fan picks|\\fan picks|fan)/gi, '')
          .replace(/make heat picks/gi, '')
          .replace(/[*_#`~\\]/g, '')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/\r\n|\r/g, '\n')
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0);

        const isScore = (s) => /^\d{1,2}(\.\d{1,2})?$/.test(s) && parseFloat(s) <= 20.0 && parseFloat(s) >= 0;
        
        const isJunkLine = (s) => {
          if (!s || s.length < 2 || s.length > 40) return true;
          const l = s.toLowerCase();

          const eventKeywords = ['rip curl', 'bells beach', 'gold coast', 'margaret river', 'corona cero', 'el salvador', 'rio pro', 'tahiti', 'fiji', 'trestles', 'portugal', 'philippines', 'pipe masters', 'championship tour', 'world surf league', 'presented by', 'bonsoy', 'vivo', 'lexus', 'outerknown', 'surf city', 'meo'];
          if (eventKeywords.some(k => l.includes(k))) return true;

          const navKeywords = ['prizes', 'heat analyzer', 'champions', 'forecast', 'official gear', 'event guide', 'schedule', 'rankings', 'surfers', 'fantasy', 'one ocean', 'store', 'inspired by', 'surf coast'];
          if (navKeywords.some(k => l.includes(k))) return true;

          if (/^round\s*\d+/i.test(l)) return true;
          if (/^(quarterfinal|semifinal)s?/i.test(l)) return true;
          if (/^heat\s*\d+/i.test(l)) return true;
          if (/^r[1-9]\s*heat\s*\d+/i.test(l)) return true;
          if (/^qf\s*heat\s*\d+/i.test(l)) return true;
          if (/^sf\s*heat\s*\d+/i.test(l)) return true;
          if (/^final/i.test(l)) return true;
          if (l.includes('waves') || l.includes('wave')) return true;
          if (l.includes('+')) return true;
          if (l === '––' || l === '-' || l === '–') return true;
          if (l.includes('picks') || l.includes('fan')) return true;

          const bad = ['winner', 'adv.', 'advancing', 'details', 'replay', 'watch', 'results', 'spoilers', 'show', 'hide', 'dawn patrol', 'call', 'upcoming', 'completed', 'draw', 'main', 'popup', 'clear', 'apply', 'selections', 'heats', 'pts', 'points', 'total', 'seed', 'event', 'tourism', 'airways', 'resort', 'surfline'];
          return bad.some(b => l === b || l.startsWith(b + ' '));
        };

        const heats = []; 

        let currentP1 = null, currentS1 = null, currentP2 = null, currentS2 = null;
        let currentRound = null, currentHeatIdx = null; 
        let heatMeta = { round: null, heatIdx: null };

        const processHeat = () => {
           if (currentP1 && currentP2 && currentP1.toLowerCase() !== currentP2.toLowerCase() && !/[\d]/.test(currentP1) && !/[\d]/.test(currentP2)) {
               let winner = null;
               if (currentS1 !== null && currentS2 !== null) {
                   if (currentS1 > currentS2) winner = currentP1;
                   else if (currentS2 > currentS1) winner = currentP2;
               }
               heats.push({ 
                 p1: currentP1, p2: currentP2, 
                 score1: currentS1, score2: currentS2, 
                 winner, 
                 round: heatMeta.round, heatIdx: heatMeta.heatIdx 
               });
           }
           currentP1 = null; currentS1 = null; currentP2 = null; currentS2 = null;
        };

        for (let i = 0; i < cleanLines.length; i++) {
          const line = cleanLines[i];
          const l = line.toLowerCase();

          let m;
          let isHeader = false;
          if (l === 'final' || l === 'grand final') {
              processHeat(); currentRound = 'final'; currentHeatIdx = 0; isHeader = true;
          } else if ((m = l.match(/^(?:qf|quarterfinal|quarterfinals)\s*heat\s*(\d+)/))) {
              processHeat(); currentRound = 'qf'; currentHeatIdx = parseInt(m[1]) - 1; isHeader = true;
          } else if ((m = l.match(/^(?:sf|semifinal|semifinals)\s*heat\s*(\d+)/))) {
              processHeat(); currentRound = 'sf'; currentHeatIdx = parseInt(m[1]) - 1; isHeader = true;
          } else if ((m = l.match(/^(?:r\d+|round\s*\d+)\s*heat\s*(\d+)/))) {
              processHeat(); const rNum = l.match(/\d+/)[0]; currentRound = 'r' + rNum; currentHeatIdx = parseInt(m[1]) - 1; isHeader = true;
          } else if ((m = l.match(/^heat\s*(\d+)/))) {
              processHeat(); currentRound = 'r1'; currentHeatIdx = parseInt(m[1]) - 1; isHeader = true;
          }

          if (isHeader) {
              heatMeta = { round: currentRound, heatIdx: currentHeatIdx };
              continue;
          }

          if (!currentRound) continue;

          if (isScore(line)) {
              if (currentP1 && currentS1 === null) currentS1 = parseFloat(line);
              else if (currentP2 && currentS2 === null) currentS2 = parseFloat(line);
          } else if (!isJunkLine(line)) {
              let isDuplicate = false;
              if (currentP1 && currentS1 === null && l.endsWith(currentP1.split(' ').pop().toLowerCase()) && line.length > currentP1.length) {
                  currentP1 = line; isDuplicate = true;
              } else if (currentP2 && currentS2 === null && l.endsWith(currentP2.split(' ').pop().toLowerCase()) && line.length > currentP2.length) {
                  currentP2 = line; isDuplicate = true;
              }

              if (!isDuplicate) {
                  if (!currentP1) currentP1 = line;
                  else if (!currentP2) currentP2 = line;
                  else {
                      processHeat();
                      currentP1 = line;
                  }
              }
          }
        }
        processHeat(); 

        const deduplicate = (arr) => {
            const unicosMap = new Map();
            arr.forEach(h => {
              const k = `${h.round}-${h.heatIdx}`; 
              if (!unicosMap.has(k)) {
                  unicosMap.set(k, h);
              } else if (unicosMap.get(k).score1 === null && h.score1 !== null) {
                  unicosMap.set(k, h); 
              }
            });
            return Array.from(unicosMap.values());
        };

        const bateriasResponse = deduplicate(heats);

        if (bateriasResponse.length === 0) {
            throw new Error(`Chaveamento indisponível na WSL para a categoria ${catParam}.`);
        }

        return new Response(JSON.stringify({ sucesso: true, quantidade: bateriasResponse.length, baterias: bateriasResponse }), { headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({ sucesso: false, mensagem: err.message }), { status: 200, headers: corsHeaders });
      }
    }

    return new Response(JSON.stringify({ sucesso: false, mensagem: "Rota não encontrada." }), { status: 404, headers: corsHeaders });
  }
};