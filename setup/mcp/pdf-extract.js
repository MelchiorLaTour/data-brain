ObjC.import('PDFKit');
ObjC.import('Foundation');

function run(argv) {
  if (argv.length !== 1) throw new Error('Provide exactly one approved PDF path.');
  const input = $.NSString.stringWithUTF8String(argv[0]);
  const url = $.NSURL.fileURLWithPath(input);
  const document = $.PDFDocument.alloc.initWithURL(url);
  if (!document) throw new Error('PDFKit could not open the selected PDF.');
  const pages = Number(ObjC.unwrap(document.pageCount));
  const text = [];
  for (let pageNumber = 0; pageNumber < pages; pageNumber += 1) {
    const page = document.pageAtIndex(pageNumber);
    const value = page.string;
    if (value) text.push(ObjC.unwrap(value));
  }
  return text.join('\n');
}
