ObjC.import('PDFKit');
ObjC.import('Foundation');

function run(argv) {
  if (argv.length !== 1) throw new Error('Provide exactly one approved PDF path.');
  const input = $.NSString.stringWithUTF8String(argv[0]);
  const url = $.NSURL.fileURLWithPath(input);
  const document = $.PDFDocument.alloc.initWithURL(url);
  if (!document) throw new Error('PDFKit could not open the selected PDF.');
  const pages = Number(ObjC.unwrap(document.pageCount));
  // A file that is not a PDF, or a locked one, must fail (non-zero exit) so it is reported as a read error and not as a scanned image.
  if (!(pages >= 1)) throw new Error('PDFKit found no pages in the selected file.');
  if (ObjC.unwrap(document.isLocked)) throw new Error('The selected PDF is locked.');
  const text = [];
  for (let pageNumber = 0; pageNumber < pages; pageNumber += 1) {
    const page = document.pageAtIndex(pageNumber);
    const value = page.string;
    if (value) text.push(ObjC.unwrap(value));
  }
  return text.join('\n');
}
