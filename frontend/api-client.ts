// API client for the frontend\nexport function fetchData(url: string) {\n  return fetch(url).then(r => r.json());\n}
