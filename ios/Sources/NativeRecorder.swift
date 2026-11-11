import AVFoundation
import UIKit

/// iPhone'un kendi kayıt bileşeni (AVAudioRecorder).
/// Uygulama "arka planda ses" izniyle (UIBackgroundModes: audio) çalıştığı için ekran
/// kilitliyken de kayıt sürer; iOS bu sırada kırmızı kayıt göstergesini gösterir.
/// Kayıt 16 kHz mono AAC (.m4a) olarak uygulamanın kendi klasörüne yazılır; telefondan çıkmaz.
final class NativeRecorder: NSObject, AVAudioRecorderDelegate {
    enum Event {
        case started(id: String)
        case state(t: TimeInterval, level: Double, paused: Bool)
        case finished(id: String, url: URL, duration: TimeInterval)
        case interrupted
        case resumed
        case error(String)
    }

    var onEvent: ((Event) -> Void)?

    private var recorder: AVAudioRecorder?
    private var meterTimer: Timer?
    private var cancelled = false
    private var lastDuration: TimeInterval = 0
    private(set) var currentId: String?
    private(set) var paused = false

    var isRecording: Bool { recorder != nil }
    var currentTime: TimeInterval { recorder?.currentTime ?? 0 }

    static var folder: URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func url(for id: String) -> URL { folder.appendingPathComponent("\(id).m4a") }

    override init() {
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(handleInterruption(_:)),
                                               name: AVAudioSession.interruptionNotification, object: nil)
    }

    // MARK: - Başlat / duraklat / bitir

    func start() {
        guard recorder == nil else { onEvent?(.error("Zaten kayıt yapılıyor.")); return }
        requestPermission { [weak self] granted in
            guard let self else { return }
            guard granted else {
                self.onEvent?(.error("Mikrofon izni verilmedi. iPhone Ayarlar → Konuşma → Mikrofon."))
                return
            }
            self.beginRecording()
        }
    }

    private func requestPermission(_ done: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission { granted in DispatchQueue.main.async { done(granted) } }
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission { granted in DispatchQueue.main.async { done(granted) } }
        }
    }

    private func beginRecording() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
            try session.setActive(true)
        } catch {
            onEvent?(.error("Ses oturumu açılamadı: \(error.localizedDescription)"))
            return
        }
        let id = "rec-\(Int(Date().timeIntervalSince1970 * 1000))"
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 32000,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
        do {
            let r = try AVAudioRecorder(url: NativeRecorder.url(for: id), settings: settings)
            r.delegate = self
            r.isMeteringEnabled = true
            guard r.record() else { onEvent?(.error("Kayıt başlatılamadı.")); return }
            recorder = r
            currentId = id
            cancelled = false
            paused = false
            lastDuration = 0
            startMeter()
            onEvent?(.started(id: id))
        } catch {
            onEvent?(.error("Kayıt başlatılamadı: \(error.localizedDescription)"))
        }
    }

    private func startMeter() {
        meterTimer?.invalidate()
        meterTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            guard let self, let r = self.recorder else { return }
            // Arka planda web görünümü uykudadır; boşuna olay gönderme (kayıt yine sürer).
            guard UIApplication.shared.applicationState == .active else { return }
            r.updateMeters()
            let db = Double(r.averagePower(forChannel: 0))
            let level = max(0, min(1, pow(10, db / 20) * 3))
            self.onEvent?(.state(t: r.currentTime, level: level, paused: self.paused))
        }
    }

    func pause() {
        guard let r = recorder, !paused else { return }
        r.pause()
        paused = true
    }

    func resume() {
        guard let r = recorder, paused else { return }
        r.record()
        paused = false
    }

    func stop() {
        guard let r = recorder else { return }
        cancelled = false
        lastDuration = r.currentTime
        r.stop() // → audioRecorderDidFinishRecording
    }

    func cancel() {
        guard let r = recorder else { return }
        cancelled = true
        r.stop()
        r.deleteRecording()
    }

    // MARK: - AVAudioRecorderDelegate

    func audioRecorderDidFinishRecording(_ r: AVAudioRecorder, successfully flag: Bool) {
        meterTimer?.invalidate()
        meterTimer = nil
        let id = currentId ?? ""
        let url = r.url
        recorder = nil
        currentId = nil
        paused = false
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        if cancelled {
            cancelled = false
            return
        }
        if FileManager.default.fileExists(atPath: url.path) {
            onEvent?(.finished(id: id, url: url, duration: lastDuration))
        } else {
            onEvent?(.error("Kayıt dosyası yazılamadı."))
        }
    }

    func audioRecorderEncodeErrorDidOccur(_ r: AVAudioRecorder, error: Error?) {
        onEvent?(.error("Kayıt hatası: \(error?.localizedDescription ?? "bilinmiyor")"))
    }

    // MARK: - Kesintiler (telefon araması vb.)

    @objc private func handleInterruption(_ n: Notification) {
        guard recorder != nil,
              let info = n.userInfo,
              let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            onEvent?(.interrupted)
        case .ended:
            try? AVAudioSession.sharedInstance().setActive(true)
            if !paused { recorder?.record() }
            onEvent?(.resumed)
        @unknown default:
            break
        }
    }

    // MARK: - Bekleyen dosyalar

    /// Bitmiş ama web tarafına henüz aktarılmamış kayıtlar (ör. aktarım sırasında uygulama kapandı).
    static func pendingIds(excluding current: String?) -> [String] {
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        return files
            .filter { $0.pathExtension == "m4a" }
            .map { $0.deletingPathExtension().lastPathComponent }
            .filter { $0 != current }
            .sorted()
    }
}
