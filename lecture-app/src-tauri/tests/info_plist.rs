#[test]
fn webview_allows_external_http_content() {
    let info_plist = include_str!("../Info.plist");

    assert!(
        info_plist.contains("<key>NSAppTransportSecurity</key>"),
        "Info.plist must declare NSAppTransportSecurity for WKWebView HTTP content"
    );
    assert!(
        info_plist.contains("<key>NSAllowsArbitraryLoadsInWebContent</key>"),
        "Info.plist must opt WKWebView into external HTTP content"
    );
    assert!(
        info_plist.contains("<key>NSAllowsArbitraryLoadsInWebContent</key>\n    <true/>"),
        "NSAllowsArbitraryLoadsInWebContent must be enabled"
    );
}
