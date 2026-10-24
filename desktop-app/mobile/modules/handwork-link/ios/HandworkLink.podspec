Pod::Spec.new do |s|
  s.name = 'HandworkLink'
  s.version = '0.1.0'
  s.summary = 'Handwork direct QUIC connection'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'Handwork'
  s.homepage = 'https://github.com/loveconnor/handwork-desktop'
  s.platforms = { :ios => '16.4' }
  s.source = { :git => 'https://github.com/loveconnor/handwork-desktop.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.resource_bundles = { 'HandworkTranscriptAssets' => ['Resources/transcript-artwork.json'] }
  s.vendored_frameworks = 'HandworkLinkCore.xcframework'
  s.frameworks = 'Security', 'SystemConfiguration', 'UIKit', 'CoreText'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
