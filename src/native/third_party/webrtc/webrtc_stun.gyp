{
    'variables': {
        'os_posix': 1,
        'lsan': 0, # ???
        'tsan': 0, # ???
    },
    'includes': [
        '../../common.gypi',
        'webrtc/supplement.gypi',
        'webrtc/build/common.gypi',
    ],
    'targets': [{
        'target_name': 'webrtc_stun',
        'type': 'static_library',
        'include_dirs' : ['.'],
        'sources': [
            'webrtc/p2p/base/stun.cc',
            'webrtc/p2p/base/stun.h',
        ],
    }]
}
