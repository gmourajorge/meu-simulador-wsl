export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api-wsl') {
      let targetURL = url.searchParams.get('url') || 'https://www.worldsurfleague.com/events/2026/ct/438/rip-curl-pro-bells-beach/results';
      const catParam = url.searchParams.get('cat') || 'masculino';
      const catId = catParam === 'feminino' ? '2' : '1';

      const baseUrl = targetURL.split('?')[0];
      const targetCatURL = `${baseUrl}?eventCatId=${catId}`;

      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Content-Type': 'application/json'
      };

      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
      }

      try {
        const headers = {
          "X-API-Key": env.ANAKIN_API_KEY,
          "Content-Type": "application/json"
        };

        const scrapeSingleUrl = async (fetchUrl) => {
          try {
            const submitRes = await fetch("https://api.anakin.io/v1/url-scraper", {
              method: "POST",
              headers,
              body: JSON.stringify({
                url: fetchUrl,
                country: "us",
                useBrowser: true,
                formats: ["markdown", "html"]
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
                } else if (result.status === "failed") break;
              }
            }
            return "";
          } catch (e) {
            return "";
          }
        };

        const rawContent = await scrapeSingleUrl(targetCatURL);

        if (!rawContent) {
          throw new Error("Não foi possível obter os dados da WSL.");
        }

        const cleanContent = rawContent
          .replace(/&nbsp;/g, ' ')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/<[^>]+>/g, '\n')
          .replace(/\d{1,2}\.\d{1,2}\s*\+\s*\d{1,2}\.\d{1,2}/g, '')
          .replace(/Make heat picks|\*Fan picks|Details|Replay|Watch [^\n]+/gi, '')
          .replace(/\r\n|\r/g, '\n');

        const lines = cleanContent.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        const isScore = (s) => /^\d{1,2}(\.\d{1,2})?$/.test(s) && parseFloat(s) <= 20.0 && parseFloat(s) > 0;
        
        const isBadName = (s) => {
          if (!s || s.length < 2 || s.length > 35 || /\d/.test(s)) return true;
          const bad = ['heat', 'round', 'replay', 'details', 'final', 'quarterfinal', 'semifinal', 'pick', 'picks', 'fan', 'watch', 'result', 'results', 'clear', 'apply', 'show', 'spoiler', 'vs', 'http', 'wave', 'fiji', 'pro', 'event', 'product', 'attribute', 'value', 'description', 'image', 'tourism', 'airways', 'resort', 'island', 'surf', 'surfline', 'corona', 'cero', 'status', 'rank'];
          const l = s.toLowerCase();
          return bad.some(b => l.includes(b));
        };

        const rawHeats = [];
        let currentRound = 'r1';

        // Mapeia contextos de rodadas no HTML raspado
        for (let i = 0; i < lines.length; i++) {
          const lLower = lines[i].toLowerCase();

          if (lLower.includes('opening round') || lLower.includes('round 1')) currentRound = 'r1';
          else if (lLower.includes('elimination round') || lLower.includes('round 2')) currentRound = 'r2';
          else if (lLower.includes('round of 32') || lLower.includes('round of 16') || lLower.includes('round 3')) currentRound = 'r3';
          else if (lLower.includes('quarterfinal') || lLower.includes('quartas')) currentRound = 'qf';
          else if (lLower.includes('semifinal') || lLower.includes('semis')) currentRound = 'sf';
          else if (lLower === 'final' || lLower === 'finals') currentRound = 'final';

          if (isScore(lines[i])) {
            let p1 = null;
            for (let b = 1; b <= 5 && (i - b) >= 0; b++) {
              if (!isBadName(lines[i - b])) {
                p1 = lines[i - b];
                break;
              }
            }

            for (let f = 1; f <= 8 && (i + f) < lines.length; f++) {
              if (isScore(lines[i + f])) {
                let p2 = null;
                for (let k = i + 1; k < i + f; k++) {
                  if (!isBadName(lines[k])) {
                    p2 = lines[k];
                    break;
                  }
                }

                if (p1 && p2 && p1 !== p2) {
                  const score1 = parseFloat(lines[i]);
                  const score2 = parseFloat(lines[i + f]);
                  let winner = null;
                  if (score1 > score2) winner = p1;
                  else if (score2 > score1) winner = p2;

                  rawHeats.push({ p1, p2, score1, score2, winner, round: currentRound });
                  i = i + f;
                  break;
                }
              }
            }
          }
        }

        // Ordena estritamente por fluxo cronológico do torneio: R1 -> R2 -> R3 -> QF -> SF -> Final
        const roundOrder = { r1: 1, r2: 2, r3: 3, qf: 4, sf: 5, final: 6 };
        rawHeats.sort((a, b) => (roundOrder[a.round] || 99) - (roundOrder[b.round] || 99));

        const unicos = [];
        const keys = new Set();
        rawHeats.forEach(h => {
          const k = `${h.round}-${h.p1}-${h.p2}`;
          const kReverse = `${h.round}-${h.p2}-${h.p1}`;
          if (!keys.has(k) && !keys.has(kReverse)) { 
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
          mensagem: "Falha na extração: " + err.message 
        }), { headers: corsHeaders });
      }
    }

    return env.ASSETS.fetch(request);
  }
};