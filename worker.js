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

    if (url.pathname === '/api-wsl') {
      let targetURL = url.searchParams.get('url');
      if (!targetURL) return new Response(JSON.stringify({ sucesso: false, mensagem: "Parâmetro 'url' obrigatório." }), { status: 400, headers: corsHeaders });

      const catParam = url.searchParams.get('cat') || 'masculino';
      const catId = catParam === 'feminino' ? '2' : '1';
      targetURL = targetURL.replace(/\/main\/?$/, '') + '/results';
      const targetCatURL = `${targetURL.split('?')[0]}?eventCatId=${catId}`;

      try {
        let rawContent = await scrapeSingleUrl(targetCatURL, 'markdown');
        if (!rawContent) throw new Error("Conteúdo da etapa veio vazio.");

        // Normalização universal: Converte tabelas Markdown (|) e HTML (<...>) em linhas individuais
        const cleanLines = rawContent
          .replace(/<[^>]+>/g, '\n')
          .replace(/\|/g, '\n')
          .replace(/[*_#`~]/g, '')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/\d+\s*waves/gi, '')
          .replace(/\d{1,2}\.\d{1,2}\s*\+\s*\d{1,2}\.\d{1,2}/g, '')
          .replace(/Make heat picks|\*Fan picks|Details|Replay|Watch [^\n]+/gi, '')
          .replace(/\r\n|\r/g, '\n')
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0);

        const isScore = (s) => /^\d{1,2}(\.\d{1,2})?$/.test(s) && parseFloat(s) <= 20.0 && parseFloat(s) >= 0;
        const isBadName = (s) => {
          if (!s || s.length < 2 || s.length > 35 || /\d/.test(s)) return true;
          const bad = ['heat', 'round', 'replay', 'details', 'final', 'quarterfinal', 'semifinal', 'pick', 'picks', 'fan', 'watch', 'result', 'results', 'clear', 'apply', 'show', 'spoiler', 'vs', 'http', 'wave', 'fiji', 'pro', 'event', 'product', 'attribute', 'value', 'description', 'image', 'tourism', 'airways', 'resort', 'island', 'surf', 'surfline', 'corona', 'cero', 'status', 'rank', 'congratulations', 'presented', 'completed', 'pts', 'points', 'total'];
          return bad.some(b => s.toLowerCase().includes(b));
        };

        const heatsMasculino = [];
        const heatsFeminino = [];
        let activeCategory = 'masculino';

        for (let i = 0; i < cleanLines.length; i++) {
          const lineLower = cleanLines[i].toLowerCase();
          
          if (lineLower.includes("women's") || lineLower.includes("womens")) {
              activeCategory = 'feminino';
          }
          if (lineLower === 'round 1' || lineLower === 'seeding round' || lineLower === 'opening round') {
              if (heatsMasculino.length > 10 && activeCategory === 'masculino') {
                  activeCategory = 'feminino';
              }
          }

          if (isScore(cleanLines[i])) {
            let p1 = null;
            for (let b = 1; b <= 5 && (i - b) >= 0; b++) {
              if (!isBadName(cleanLines[i - b])) { p1 = cleanLines[i - b]; break; }
            }

            for (let f = 1; f <= 8 && (i + f) < cleanLines.length; f++) {
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
                  
                  const obj = { p1, p2, score1, score2, winner };
                  if (activeCategory === 'masculino') heatsMasculino.push(obj);
                  else heatsFeminino.push(obj);

                  i = i + f;
                  break;
                }
              }
            }
          }
        }

        const deduplicate = (arr) => {
            const unicos = [];
            const keys = new Set();
            arr.forEach(h => {
              const k = `${h.p1}-${h.p2}`; const kRev = `${h.p2}-${h.p1}`;
              if (!keys.has(k) && !keys.has(kRev)) { keys.add(k); unicos.push(h); }
            });
            return unicos;
        };

        const finalMasculino = deduplicate(heatsMasculino);
        const finalFeminino = deduplicate(heatsFeminino);

        let bateriasResponse = [];
        if (catParam === 'feminino') {
            if (finalFeminino.length > 0) bateriasResponse = finalFeminino;
            else if (finalMasculino.length > 40) bateriasResponse = finalMasculino.slice(-23); 
            else bateriasResponse = finalMasculino;
        } else {
            bateriasResponse = finalMasculino.length > 0 ? finalMasculino : finalFeminino;
        }

        return new Response(JSON.stringify({ sucesso: true, quantidade: bateriasResponse.length, baterias: bateriasResponse }), { headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({ sucesso: false, mensagem: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response(JSON.stringify({ sucesso: false, mensagem: "Rota não encontrada." }), { status: 404, headers: corsHeaders });
  }
};