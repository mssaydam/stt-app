import UIKit
import WebKit

/// Konuşma Defteri web uygulamasını (https://mssaydam.github.io/stt-app/) açar ve ona
/// `window.webkit.messageHandlers.kdNative` köprüsüyle iPhone'un kayıt bileşenini sunar.
/// Ses işleme (konuşmacı ayırma, metne çevirme) yine sayfada, telefonda yapılır.
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
    private var webView: WKWebView!
    private let recorder = NativeRecorder()
    private let startURL = URL(string: "https://mssaydam.github.io/stt-app/")!
    private var downloadTargets: [ObjectIdentifier: URL] = [:]

    // MARK: - Kurulum

    override func loadView() {
        let config = WKWebViewConfiguration()
        // Service worker (çevrimdışı açılış) için uygulamaya bağlı alan adı (Info.plist: WKAppBoundDomains)
        config.limitsNavigationsToAppBoundDomains = true
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = .default()

        let content = WKUserContentController()
        content.add(WeakScriptHandler(self), name: "kdNative")
        let boot = "window.KD_NATIVE = { platform: 'ios', version: 1 };"
        content.addUserScript(WKUserScript(source: boot, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = content

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = false
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.isOpaque = false
        wv.backgroundColor = .systemBackground
        if #available(iOS 16.4, *) { wv.isInspectable = true }
        webView = wv
        view = wv
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        recorder.onEvent = { [weak self] event in self?.handle(event) }
        webView.load(URLRequest(url: startURL))
    }

    // MARK: - Web → yerel

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        let id = body["id"] as? String
        switch cmd {
        case "start":
            recorder.start()
        case "pause":
            recorder.pause()
            emit(["type": "paused"])
        case "resume":
            recorder.resume()
            emit(["type": "resumed"])
        case "stop":
            recorder.stop()
        case "cancel":
            recorder.cancel()
            emit(["type": "cancelled"])
        case "status":
            emit(["type": "status", "recording": recorder.isRecording, "id": recorder.currentId ?? "",
                  "t": recorder.currentTime, "paused": recorder.paused])
        case "listPending":
            emit(["type": "pending", "ids": NativeRecorder.pendingIds(excluding: recorder.currentId)])
        case "fetch":
            if let id { sendFile(id: id, duration: 0) }
        case "ack", "discard":
            // Web tarafı kaydı kendi deposuna aldı (ya da silinmesini istedi) → yerel kopyayı sil
            if let id { try? FileManager.default.removeItem(at: NativeRecorder.url(for: id)) }
        default:
            break
        }
    }

    // MARK: - Yerel → web

    private func handle(_ event: NativeRecorder.Event) {
        switch event {
        case .started(let id):
            emit(["type": "started", "id": id])
        case .state(let t, let level, let paused):
            emit(["type": "state", "t": t, "level": level, "paused": paused])
        case .finished(let id, _, let duration):
            sendFile(id: id, duration: duration)
        case .interrupted:
            emit(["type": "interrupted"])
        case .resumed:
            emit(["type": "resumed"])
        case .error(let message):
            emit(["type": "error", "message": message])
        }
    }

    private func emit(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.KD_NATIVE_EVENT && window.KD_NATIVE_EVENT(\(json))", completionHandler: nil)
    }

    /// Kayıt dosyasını parçalar hâlinde (base64) sayfaya aktarır. Sayfa kaydı kendi deposuna
    /// alınca "ack" gönderir; o zamana kadar dosya burada saklanır (uygulama kapanırsa kaybolmaz).
    private func sendFile(id: String, duration: TimeInterval) {
        let url = NativeRecorder.url(for: id)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let data = try? Data(contentsOf: url) else {
                DispatchQueue.main.async { self?.emit(["type": "error", "message": "Kayıt dosyası okunamadı."]) }
                return
            }
            let chunkSize = 512 * 1024
            let total = max(1, (data.count + chunkSize - 1) / chunkSize)
            var parts: [String] = []
            parts.reserveCapacity(total)
            for i in 0..<total {
                let lo = i * chunkSize
                let hi = min(data.count, lo + chunkSize)
                parts.append(data.subdata(in: lo..<hi).base64EncodedString())
            }
            DispatchQueue.main.async {
                guard let self else { return }
                for (i, b64) in parts.enumerated() {
                    self.emit(["type": "chunk", "id": id, "i": i, "n": total, "b64": b64])
                }
                self.emit(["type": "done", "id": id, "mime": "audio/mp4", "duration": duration, "bytes": data.count])
            }
        }
    }

    // MARK: - Mikrofon izni (sayfanın kendi kayıt yolu için)

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == startURL.host ? .grant : .deny)
    }

    // MARK: - Gezinme: dış bağlantılar Safari'de, indirmeler paylaşım menüsünde

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        if let url = action.request.url, let scheme = url.scheme, ["http", "https"].contains(scheme),
           url.host != startURL.host {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { UIApplication.shared.open(url) }
        return nil
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let target = dir.appendingPathComponent(suggestedFilename)
        downloadTargets[ObjectIdentifier(download)] = target
        completionHandler(target)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = downloadTargets.removeValue(forKey: ObjectIdentifier(download)) else { return }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        present(sheet, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadTargets.removeValue(forKey: ObjectIdentifier(download))
    }

    // MARK: - Hata durumları

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showOfflinePage()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // Sayfa bellek yüzünden kapandıysa yeniden yükle (yerel kayıt bundan etkilenmez).
        webView.load(URLRequest(url: startURL))
    }

    private func showOfflinePage() {
        let html = """
        <!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
        <body style="font:17px -apple-system;padding:48px 24px;text-align:center;color:#444">
        <h2>Bağlantı kurulamadı</h2>
        <p>Uygulama ilk açılışta bir kez internete ihtiyaç duyar; sonrasında internetsiz çalışır.</p>
        <p><a href="\(startURL.absoluteString)" style="font-size:19px">Tekrar dene</a></p></body>
        """
        webView.loadHTMLString(html, baseURL: startURL)
    }
}

/// WKUserContentController betik işleyicisini güçlü tuttuğu için döngüyü kıran ara sınıf.
final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
