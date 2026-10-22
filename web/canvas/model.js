export function canvasSentences(canvas) {
  const sentences = [], chapters = [], pages = [];
  function walk(items, depth = 0) {
    for (const chapter of items || []) {
      const entry = { id: chapter._id, title: chapter.title, depth, startIndex: sentences.length };
      chapters.push(entry);
      for (const [index, page] of (chapter.pages || []).entries()) {
        const item = { id: page._id, title: page.title, chapterId: chapter._id, chapterTitle: chapter.title,
          number: index + 1, total: chapter.pages.length, startIndex: sentences.length };
        for (const sentence of page.sentences || []) {
          sentences.push({ ...sentence, chapterId: chapter._id, chapterTitle: chapter.title, pageId: page._id });
        }
        item.endIndex = sentences.length;
        if (item.endIndex > item.startIndex) pages.push(item);
      }
      walk(chapter.subchapters, depth + 1);
      entry.endIndex = sentences.length;
    }
  }
  walk(canvas.chapters);
  return { sentences, chapters, pages };
}

export function canvasPage(model, sentenceIndex) {
  return model.pages.find(page => sentenceIndex >= page.startIndex && sentenceIndex < page.endIndex);
}

export function connectAiPrompt(guideUrl) {
  return `Instructions for the AI:

Please send text into this player.
Read ${guideUrl}.
Show or open the player link.

My text or request:
[Add your text / request here.]`;
}

export function canvasPrompt({ canvas, apiBase, uploadCode, expiresAt }) {
  return `Read ${new URL('guide.html', canvas.url).href}.
Send my text to this Canvas.

Canvas: ${canvas.url}
Upload address: ${apiBase}/canvases/${canvas._id}/chapters/INDEX
Upload code: ${uploadCode}
The upload code expires at ${new Date(expiresAt).toISOString()}.

Use HTTP PUT with Authorization: Bearer UPLOAD_CODE.
Replace UPLOAD_CODE with the upload code above.
Start chapter indexes at 0.
Use the text format in the guide.
Open the player link after you save the text.
Keep the upload code private.

My text or request:
[Add text or a request.]`;
}
