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
        let apiError = errText;
        try {
            const jsonError = JSON.parse(errText);
            apiError = jsonError.message || jsonError.error || errText;
        } catch(e) {}
        throw new Error("Anakin (HTTP " + submitRes.status + "): " + apiError + " | URL: " + fetchUrl);
      }

      const jobData = await submitRes.json();
      const jobId = jobData.jobId || jobData.id;
      if (!jobId) throw new Error("Anakin.io nao gerou o ID do job.");

      let attempts = 0;
      while (attempts < 12) {
        await new Promise(r => setTimeout(r, 4000));
        attempts++;

        const pollRes = await fetch("https://api.anakin.io/v1/url-scraper/" + jobId, { headers });
        if (pollRes.ok) {
          const result = await pollRes.json();
          if (result.status === "completed") {
            return result.markdown || result.html || (result.data ? result.data.markdown || result.data.html : "");
          } else if (result.status === "failed") {
            throw new Error("Falha no servidor do Anakin ao ler a pagina.");
          }
        }
      }
      throw new Error("Timeout: A WSL demorou mais de 45s na validacao anti-bot.");
    };

    // =========================================================================
    // 1. Calendario (/api-events)
    // =========================================================================
    if (url.pathname === '/api-events') {
      try {
        const content = await scrapeSingleUrl('https://www.worldsurfleague.com/events/2026/ct?all=1', 'html');
        if (!content) throw new Error("A pagina do calendario veio vazia.");

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
              id: slug + "-" + eventId,
              wslUrl: "https://www.worldsurfleague.com/events/2026/ct/" + eventId + "/" + slug + "/results",
              name: (eventsFound.length + 1) + ". " + formattedName,
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
    // 2. Resultados Dinamicos (/api-wsl)
    // =========================================================================
    if (url.pathname === '/api-wsl') {
      let targetURL = url.searchParams.get('url');
      if (!targetURL) return new Response(JSON.stringify({ sucesso: false, mensagem: "Parametro 'url' obrigatorio." }), { status: 400, headers: corsHeaders });

      const catParam = url.searchParams.get('cat') || 'masculino';
      const catId = catParam === 'feminino' ? '2' : '1';
      
      const cleanBase = targetURL.replace(/\/(main|results)\/?(?:[?#].*)?$/, '');
      const resultsURL = cleanBase + '/results?eventCatId=' + catId;

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
            mensagem: "A WSL ainda nao disponibilizou o chaveamento oficial desta etapa." 
          }), { status: 200, headers: corsHeaders });
        }

        let targetStatId = null;
        let genderUrl = null;
        
        // Agora extraimos o Href (URL) completa do site ao inves de so adivinhar o ID
        const regexFeminino = new RegExp("\\x5B[^\\x5D]*Women's[^\\x5D]*\\x5D\\x28([^\\x29]*statEventId=(\\d+)[^\\x29]*)\\x29", "i");
        const regexMasculino = new RegExp("\\x5B[^\\x5D]*Men's[^\\x5D]*\\x5D\\x28([^\\x29]*statEventId=(\\d+)[^\\x29]*)\\x29", "i");
        
        let matchStat = rawContent.match(catParam === 'feminino' ? regexFeminino : regexMasculino);
        
        if (!matchStat) {
            const regexOpposite = catParam === 'feminino' ? regexMasculino : regexFeminino;
            const opostoMatch = rawContent.match(regexOpposite);
            if (opostoMatch) {
                const opostoId = parseInt(opostoMatch[2]);
                targetStatId = catParam === 'feminino' ? (opostoId + 1).toString() : (opostoId - 1).toString();
            }
        } else {
            genderUrl = matchStat[1];
            targetStatId = matchStat[2];
        }

        // Se a WSL redirecionou (ex: para /posts/), nos seguimos obedientemente
        if (genderUrl) {
            let explicitBaseUrl = genderUrl;
            if (explicitBaseUrl.startsWith('/')) explicitBaseUrl = "https://www.worldsurfleague.com" + explicitBaseUrl;
            else if (!explicitBaseUrl.startsWith('http')) explicitBaseUrl = "https://www.worldsurfleague.com/" + explicitBaseUrl;
            
            await new Promise(r => setTimeout(r, 2000));
            rawContent = await scrapeSingleUrl(explicitBaseUrl, 'markdown');
        } else if (targetStatId) {
            const explicitBaseUrl = cleanBase + "/results?statEventId=" + targetStatId;
            await new Promise(r => setTimeout(r, 2000));
            rawContent = await scrapeSingleUrl(explicitBaseUrl, 'markdown');
        }

        let extraContents = [];
        let targetHrefs = [];
        
        // Coletamos as URLs completas da aba de Bracket gerada pela WSL
        const bracketRegex = new RegExp("\\x5B(?:Bracket|Heat Draw)[^\\x5D]*\\x5D\\x28([^\\x29]*roundId=\\d+[^\\x29]*)\\x29", "i");
        const bracketMatch = rawContent.match(bracketRegex);
        
        if (bracketMatch) {
            targetHrefs.push(bracketMatch[1]);
        } else {
            const allRoundUrls = [...rawContent.matchAll(new RegExp("\\x28([^\\x29]*roundId=\\d+[^\\x29]*)\\x29", "ig"))].map(m => m[1]);
            const uniqueUrls = [...new Set(allRoundUrls)];
            if (uniqueUrls.length > 0) targetHrefs.push(...uniqueUrls.slice(0, 2));
        }

        const urlParam = targetStatId ? "statEventId=" + targetStatId : "eventCatId=" + catId;

        for (let href of targetHrefs) {
            let u = href;
            if (u.startsWith('/')) u = "https://www.worldsurfleague.com" + u;
            else if (!u.startsWith('http')) u = "https://www.worldsurfleague.com/" + u;
            
            // Tratamento inteligente de seguranca da URL
            if (targetStatId && !u.includes("statEventId=" + targetStatId)) {
                if (u.includes("statEventId=")) {
                    u = u.replace(/statEventId=\d+/, "statEventId=" + targetStatId);
                } else {
                    const separator = u.includes('?') ? '&' : '?';
                    u = u + separator + urlParam;
                }
            } else if (!targetStatId && !u.includes("eventCatId=")) {
                 const separator = u.includes('?') ? '&' : '?';
                 u = u + separator + urlParam;
            }

            await new Promise(r => setTimeout(r, 2000));
            const md = await scrapeSingleUrl(u, 'markdown');
            extraContents.push(md);
        }
        
        const fullMarkdown = [rawContent, ...extraContents].join('\n\n');

        const markdownLinkRegex = new RegExp("\\x5B([^\\x5D]+)\\x5D\\x28[^\\x29]+\\x29", "g");

        const cleanLines = fullMarkdown
          .replace(/<[^>]+>/g, '\n')
          .replace(/\|/g, '\n')
          .replace(/make heat picks.*?(fan picks|\*fan picks|\\fan picks|fan)/gi, '')
          .replace(/make heat picks/gi, '')
          .replace(/[*_#`~\\]/g, '')
          .replace(markdownLinkRegex, '$1')
          .replace(/\r\n|\r/g, '\n')
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0);

        const isScore = (s) => /^\d{1,2}(\.\d{1,2})?$/.test(s) && parseFloat(s) <= 20.0 && parseFloat(s) >= 0;
        
        const isJunkLine = (s) => {
          if (!s || s.length < 2 || s.length > 40) return true;
          const l = s.toLowerCase();

          if (/^-+$/.test(l)) return true;

          const eventKeywords = ['rip curl', 'bells beach', 'gold coast', 'margaret river', 'corona cero', 'el salvador', 'rio pro', 'tahiti', 'fiji', 'trestles', 'portugal', 'philippines', 'pipe masters', 'championship tour', 'world surf league', 'presented by', 'bonsoy', 'vivo', 'lexus', 'outerknown', 'surf city', 'meo'];
          if (eventKeywords.some(k => l.includes(k))) return true;

          const navKeywords = ['prizes', 'heat analyzer', 'champions', 'forecast', 'official gear', 'event guide', 'schedule', 'rankings', 'surfers', 'fantasy', 'one ocean', 'store', 'inspired by', 'surf coast', 'shop', 'cart', 'checkout', 'privacy', 'terms', 'support'];
          if (navKeywords.some(k => l.includes(k))) return true;

          if (l.includes("men's heats") || l.includes("women's heats")) return true;

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
          
          if (l.startsWith('winner adv')) return true;
          if (l === 'event' || l === 'events') return true;

          const bad = ['adv.', 'advancing', 'details', 'replay', 'watch', 'results', 'spoilers', 'show', 'hide', 'dawn patrol', 'call', 'upcoming', 'completed', 'draw', 'main', 'popup', 'clear', 'apply', 'selections', 'heats', 'pts', 'points', 'total', 'tourism', 'airways', 'resort', 'surfline', 'product', 'attribute', 'color', 'size', 'price', 'item', 'shipping', 'description', 'value', 'sku', 'qty', 'quantity', 'name', 'image', 'photo', 'picture', 'live', 'in the water', 'status', 'heat status', 'watching', 'now playing'];
          return bad.some(b => l === b || l.startsWith(b + ' '));
        };

        const heats = []; 

        let currentP1 = null, currentS1 = null, currentP2 = null, currentS2 = null;
        let currentRound = null, currentHeatIdx = null; 
        let heatMeta = { round: null, heatIdx: null };

        const processHeat = () => {
           if (currentP1 || currentP2) {
               
               const cleanName = (name) => {
                   if (!name) return 'Aguardando...';
                   const low = name.toLowerCase();
                   if (low.includes('seed') || low.includes('winner') || low.includes('tbd') || low.includes('tbc') || /[\d]/.test(name)) {
                       return 'Aguardando...';
                   }
                   return name;
               };

               const finalP1 = cleanName(currentP1);
               const finalP2 = cleanName(currentP2);

               const isInvalid = (finalP1 !== 'Aguardando...' && finalP2 !== 'Aguardando...' && finalP1.toLowerCase() === finalP2.toLowerCase());

               if (!isInvalid && (finalP1 !== 'Aguardando...' || finalP2 !== 'Aguardando...')) {
                   let winner = null;
                   if (currentS1 !== null && currentS2 !== null) {
                       if (currentS1 > currentS2) winner = finalP1;
                       else if (currentS2 > currentS1) winner = finalP2;
                   }
                   heats.push({ 
                     p1: finalP1, p2: finalP2, 
                     score1: currentS1, score2: currentS2, 
                     winner, 
                     round: heatMeta.round, heatIdx: heatMeta.heatIdx 
                   });
               }
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
              const k = h.round + "-" + h.heatIdx; 
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
            throw new Error("Chaveamento indisponivel na WSL para a categoria solicitada.");
        }

        return new Response(JSON.stringify({ sucesso: true, quantidade: bateriasResponse.length, baterias: bateriasResponse }), { headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({ sucesso: false, mensagem: err.message }), { status: 200, headers: corsHeaders });
      }
    }

    return new Response(JSON.stringify({ sucesso: false, mensagem: "Rota nao encontrada." }), { status: 404, headers: corsHeaders });
  }
};