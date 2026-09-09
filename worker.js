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
    // 2. Resultados Dinâmicos (/api-wsl) - PARSER ORIENTADO A CONTEXTO
    // =========================================================================
    if (url.pathname === '/api-wsl') {
      let targetURL = url.searchParams.get('url');
      if (!targetURL) return new Response(JSON.stringify({ sucesso: false, mensagem: "Parâmetro 'url' obrigatório." }), { status: 400, headers: corsHeaders });

      const catParam = url.searchParams.get('cat') || 'masculino';
      const catId = catParam === 'feminino' ? '2' : '1';
      
      const cleanBase = targetURL.replace(/\/(main|results)\/?$/, '');
      const resultsURL = `${cleanBase}/results?eventCatId=${catId}`;

      const isReal404 = (content) => {
        if (!content) return true;
        const lower = content.toLowerCase();
        return lower.includes('404 wipeout') || lower.includes('# 404');
      };

      try {
        const rawContent = await scrapeSingleUrl(resultsURL, 'markdown');

        if (isReal404(rawContent)) {
          return new Response(JSON.stringify({ 
            sucesso: false, 
            mensagem: "A WSL ainda não disponibilizou o chaveamento oficial desta etapa." 
          }), { status: 200, headers: corsHeaders });
        }

        // Limpa lixo de formatação e remove todos os links para anular botões como [Details] e [Replay]
        const cleanLines = rawContent
          .replace(/<[^>]+>/g, '\n')
          .replace(/\|/g, '\n')
          .replace(/[*_#`~]/g, '')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '')
          .replace(/\r\n|\r/g, '\n')
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0);

        const isScore = (s) => /^\d{1,2}(\.\d{1,2})?$/.test(s) && parseFloat(s) <= 20.0 && parseFloat(s) >= 0;

        const heatsMasculino = [];
        const heatsFeminino = [];
        let activeCategory = 'masculino';

        // Variáveis de Estado (Contexto)
        let currentRound = null;
        let currentHeatIdx = null;
        let p1 = null, s1 = null, p2 = null, s2 = null;

        const saveHeat = () => {
            if (currentRound && p1 && p2 && p1.toLowerCase() !== p2.toLowerCase()) {
                let winner = null;
                if (s1 !== null && s2 !== null) {
                    if (s1 > s2) winner = p1;
                    else if (s2 > s1) winner = p2;
                }
                const heatObj = { p1, p2, score1: s1, score2: s2, winner, round: currentRound, heatIdx: currentHeatIdx };
                if (activeCategory === 'masculino') heatsMasculino.push(heatObj);
                else heatsFeminino.push(heatObj);
            }
            p1 = null; s1 = null; p2 = null; s2 = null;
        };

        for (let i = 0; i < cleanLines.length; i++) {
          const line = cleanLines[i];
          const l = line.toLowerCase();
          
          // Mudança de Categoria: Reseta o estado para garantir que não puxe lixo na transição
          if (l.includes("women's") || l.includes("womens")) {
              saveHeat();
              activeCategory = 'feminino';
              currentRound = null; 
              continue;
          }

          // Identificação Estrita de Cabeçalho (Ativa o Contexto)
          let m;
          let isHeader = false;
          if (l === 'final' || l === 'grand final') {
              saveHeat(); currentRound = 'final'; currentHeatIdx = 0; isHeader = true;
          } else if ((m = l.match(/^(?:qf|quarterfinal|quarterfinals)\s*heat\s*(\d+)/))) {
              saveHeat(); currentRound = 'qf'; currentHeatIdx = parseInt(m[1]) - 1; isHeader = true;
          } else if ((m = l.match(/^(?:sf|semifinal|semifinals)\s*heat\s*(\d+)/))) {
              saveHeat(); currentRound = 'sf'; currentHeatIdx = parseInt(m[1]) - 1; isHeader = true;
          } else if ((m = l.match(/^(?:r\d+|round\s*\d+)\s*heat\s*(\d+)/))) {
              saveHeat(); const rNum = l.match(/\d+/)[0]; currentRound = 'r' + rNum; currentHeatIdx = parseInt(m[1]) - 1; isHeader = true;
          } else if ((m = l.match(/^heat\s*(\d+)/))) {
              saveHeat(); currentRound = 'r1'; currentHeatIdx = parseInt(m[1]) - 1; isHeader = true;
          }

          if (isHeader) continue;

          // REGRA DE OURO: Se não encontrou nenhum cabeçalho válido ainda, ignore a linha!
          if (!currentRound) continue;

          // Ignora lixo interno estrutural que aparece dentro do bloco da bateria
          if (l.includes('winner adv') || l.includes('picks') || l.includes('fan') ||
              l === '––' || l === '-' || l === '–' ||
              l.includes('no waves') || l.includes('waves') || l.includes('wave') ||
              l.includes('+') || l.includes('seed')) {
              continue;
          }

          // Processamento de Notas
          if (isScore(line)) {
              if (p1 && !p2 && s1 === null) s1 = parseFloat(line);
              else if (p1 && p2 && s2 === null) s2 = parseFloat(line);
              continue;
          }

          // Processamento de Nomes (Apenas se a linha tiver o tamanho coerente com nomes)
          if (line.length > 1 && line.length < 40 && !/[\d]/.test(line)) {
              let isExpansion = false;
              // Detecta se a linha atual é a versão longa da linha anterior (L. Thompson -> Luke Thompson)
              if (p1 && s1 === null && l.endsWith(p1.split(' ').pop().toLowerCase()) && line.length > p1.length) {
                  p1 = line; isExpansion = true;
              } else if (p2 && s2 === null && l.endsWith(p2.split(' ').pop().toLowerCase()) && line.length > p2.length) {
                  p2 = line; isExpansion = true;
              }

              if (!isExpansion) {
                  if (!p1) p1 = line;
                  else if (!p2) p2 = line;
                  else {
                      // Se um terceiro nome apareceu, a bateria encerrou e o cabeçalho falhou. Salva e inicia nova.
                      saveHeat();
                      p1 = line;
                  }
              }
          }
        }
        saveHeat(); // Garante o salvamento da última bateria em memória

        // Deduplicação final por coordenadas
        const deduplicate = (arr) => {
            const unicosMap = new Map();
            arr.forEach(h => {
              const k = `${h.round}-${h.heatIdx}`; 
              if (!unicosMap.has(k)) {
                  unicosMap.set(k, h);
              } else if (unicosMap.get(k).score1 === null && h.score1 !== null) {
                  unicosMap.set(k, h); // Substitui a versão "Aguardando" por uma com notas reais
              }
            });
            return Array.from(unicosMap.values());
        };

        const finalMasculino = deduplicate(heatsMasculino);
        const finalFeminino = deduplicate(heatsFeminino);

        let bateriasResponse = catParam === 'feminino' ? finalFeminino : finalMasculino;
        if (bateriasResponse.length === 0) bateriasResponse = (catParam === 'feminino') ? finalMasculino.slice(-23) : finalMasculino;

        if (bateriasResponse.length === 0) {
            throw new Error("Chaveamento indisponível na WSL para esta categoria.");
        }

        return new Response(JSON.stringify({ sucesso: true, quantidade: bateriasResponse.length, baterias: bateriasResponse }), { headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({ sucesso: false, mensagem: err.message }), { status: 200, headers: corsHeaders });
      }
    }

    return new Response(JSON.stringify({ sucesso: false, mensagem: "Rota não encontrada." }), { status: 404, headers: corsHeaders });
  }
};