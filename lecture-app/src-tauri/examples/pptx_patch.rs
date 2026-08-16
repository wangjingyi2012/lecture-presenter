// pptx_patch — offline helper: inject a <p:timing> animation manifest into a pptx.
// Usage: pptx_patch <input.pptx> <manifest.json> <output.pptx>
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        eprintln!("usage: pptx_patch <input.pptx> <manifest.json> <output.pptx>");
        std::process::exit(2);
    }
    let bytes = std::fs::read(&args[1]).expect("read input pptx");
    let manifest_text = std::fs::read_to_string(&args[2]).expect("read manifest");
    let manifest: Vec<lecture_app_lib::PptxSlideAnimation> =
        serde_json::from_str(&manifest_text).expect("parse manifest");
    let patched = lecture_app_lib::patch_pptx_animations(&bytes, &manifest).expect("patch");
    std::fs::write(&args[3], patched).expect("write output");
    println!("patched -> {}", args[3]);
}
