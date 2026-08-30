function fileToBase64(file) {
  if (!(file instanceof Blob)) {
    return Promise.reject(new Error('analyzeInventoryImage expects a File/Blob, not a URL or string.'))
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1])   // strip data:...;base64, prefix
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export async function analyzeInventoryImage(file) {
  const base64 = await fileToBase64(file)
  const res = await fetch('/api/analyze-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64: base64, mimeType: file.type || 'image/jpeg' }), 
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Image analysis failed')
  return data.result
}