FROM node:22-alpine
CMD ["node", "-e", "let n=0; console.log('worker started'); setInterval(()=>console.log('tick', ++n), 2000)"]
