import AppKit
import ApplicationServices
import Carbon
import CoreGraphics

struct NativeFailure: Error { let code: String }

@MainActor final class RemoteInput {
    private var pressed = Set<CGKeyCode>()
    private var mouseDown = false
    private var lastPoint = CGPoint.zero
    private let special: [String: CGKeyCode] = ["Enter":36,"Tab":48,"Space":49,"Backspace":51,"Escape":53,"Delete":117,"Home":115,"End":119,"PageUp":116,"PageDown":121,"ArrowLeft":123,"ArrowRight":124,"ArrowDown":125,"ArrowUp":126]

    func releaseAll() {
        for code in pressed { CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:false)?.post(tap:.cghidEventTap) }
        pressed.removeAll()
        if mouseDown { CGEvent(mouseEventSource:nil,mouseType:.leftMouseUp,mouseCursorPosition:lastPoint,mouseButton:.left)?.post(tap:.cghidEventTap) }
        mouseDown = false
    }

    private func layout() throws -> [String: (CGKeyCode, CGEventFlags)] {
        guard let source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue(),
              let pointer = TISGetInputSourceProperty(source,kTISPropertyUnicodeKeyLayoutData) else { throw NativeFailure(code:"keyboard-layout-unavailable") }
        let data = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue()
        let keyboard = UnsafeRawPointer(CFDataGetBytePtr(data)).assumingMemoryBound(to:UCKeyboardLayout.self)
        var result: [String:(CGKeyCode,CGEventFlags)] = [:]
        for flags: CGEventFlags in [[],.maskShift,.maskAlternate,[.maskShift,.maskAlternate]] {
            for code: UInt16 in 0..<128 {
                var dead: UInt32 = 0; var length: Int = 0; var buffer = [UniChar](repeating:0,count:8)
                let status = UCKeyTranslate(keyboard,code,UInt16(kUCKeyActionDown),UInt32((flags.rawValue >> 16) & 0xff),UInt32(LMGetKbdType()),OptionBits(kUCKeyTranslateNoDeadKeysBit),&dead,8,&length,&buffer)
                guard status == noErr, length > 0 else { continue }
                let text = String(utf16CodeUnits:buffer,count:length)
                if result[text] == nil { result[text] = (code,flags) }
            }
        }
        return result
    }

    private func key(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) throws {
        guard let event = CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:down) else { throw NativeFailure(code:"input-event-unavailable") }
        event.flags = flags; event.post(tap:.cghidEventTap)
        if down { pressed.insert(code) } else { pressed.remove(code) }
    }

    func dispatch(_ input: [String:Any], bounds: CGRect) throws {
        guard AXIsProcessTrusted() else { throw NativeFailure(code:"accessibility-required") }
        if input["kind"] as? String == "key" {
            let text = input["text"] as? String ?? ""
            let code = input["code"] as? String ?? ""
            let down = input["action"] as? String != "up"
            var flags: CGEventFlags = []
            for name in input["modifiers"] as? [String] ?? [] {
                switch name { case "Shift":flags.insert(.maskShift);case "Alt":flags.insert(.maskAlternate);case "Meta":flags.insert(.maskCommand);case "Control":flags.insert(.maskControl);default:break }
            }
            if let physical = special[code] { try key(physical,down:down,flags:flags); return }
            if !down { return }
            if ["ShiftLeft","ShiftRight","ControlLeft","ControlRight","AltLeft","AltRight","MetaLeft","MetaRight","CapsLock"].contains(code) { return }
            guard !text.isEmpty, text.utf8.count <= 2048 else { throw NativeFailure(code:"invalid-key-text") }
            let map = try layout()
            // Validate the whole batch before emitting any character, including whitespace.
            let sequence = try text.map { character -> (CGKeyCode,CGEventFlags) in
                guard let stroke = map[String(character)] else { throw NativeFailure(code:"unsupported-keyboard-character") }
                return stroke
            }
            let initialLock=lockedScreen()
            for (physical, modifiers) in sequence {
                guard lockedScreen() == initialLock else { releaseAll();throw NativeFailure(code:"stale-control-session") }
                try key(physical,down:true,flags:modifiers.union(flags));try key(physical,down:false,flags:modifiers.union(flags))
                usleep(4000)
            }
            return
        }
        guard input["kind"] as? String == "pointer", let x=input["x"] as? Double, let y=input["y"] as? Double, x.isFinite,y.isFinite,(0...1).contains(x),(0...1).contains(y) else { throw NativeFailure(code:"invalid-pointer") }
        guard input["button"] as? String ?? "left" == "left" else { throw NativeFailure(code:"unsupported-mouse-button") }
        let point=CGPoint(x:bounds.minX+x*bounds.width,y:bounds.minY+y*bounds.height); lastPoint=point
        let action=input["action"] as? String ?? ""
        if action == "wheel" {
            let dx=max(-2000,min(2000,input["deltaX"] as? Double ?? 0));let dy=max(-2000,min(2000,input["deltaY"] as? Double ?? 0))
            guard dx.isFinite,dy.isFinite else { throw NativeFailure(code:"invalid-wheel") }
            CGEvent(scrollWheelEvent2Source:nil,units:.pixel,wheelCount:2,wheel1:Int32(-dy),wheel2:Int32(-dx),wheel3:0)?.post(tap:.cghidEventTap);return
        }
        let type: CGEventType
        switch action { case "down":type = .leftMouseDown;mouseDown=true;case "up":type = .leftMouseUp;mouseDown=false;case "move":type = mouseDown ? .leftMouseDragged : .mouseMoved;default:throw NativeFailure(code:"invalid-pointer") }
        guard let event=CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:point,mouseButton:.left) else { throw NativeFailure(code:"input-event-unavailable") }
        if action == "down" || action == "up" { event.setIntegerValueField(.mouseEventClickState,value:1) }
        event.post(tap:.cghidEventTap)
    }
}
