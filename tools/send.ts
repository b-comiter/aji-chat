const msg = process.argv[2] ?? 'hello from server'
const res = await fetch('http://localhost:4000/send', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: msg }),
})
console.log(await res.json())
