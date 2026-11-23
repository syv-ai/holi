// Holi: stands in for foliate's pdf.js, which imports a bundled PDF.js. Holi
// opens PDFs in its own viewer, so a PDF never reaches foliate.
export const makePDF = () => {
  throw new Error('PDF is opened by Holi’s PDF viewer, not here')
}
