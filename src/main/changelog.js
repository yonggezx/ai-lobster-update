
// type: feature(新功能) | fix(修复) | improvement(优化) | notice(公告)

const CHANGELOG = [
  {
    version: '1.0.4',
    date: '2026-08-24',
    title: '赛博龙虾大进化！BongoCat猫模型适配 + MMD动作编辑器与AI大脑深度合体（AI效果看模型脑子好不好使）',
    changes: [
      // ===== 新增功能 =====
      { type: 'feature', title: '模型信息面板变身可视化快乐编辑器', desc: '冲进「模型管理」点一下模型，名字、描述随便改，改完立刻看效果，所见即虾所得' },
      { type: 'feature', title: '超酷动作编辑器（3D实时围观 + 可视化搓动作 + 时间轴大舞台）', desc: '模型管理页给MMD模型手工搓动作：调骨骼旋转、挪身体、捏表情；也可以使唤AI生成动作，做完还能起名存档。大窗口实时预览，下方时间轴带刻度、播放头、关键帧标记；点标尺跳转，拖拽标记挪动时间；独立窗口放飞你的创作，操作不再憋屈' },
      { type: 'feature', title: '连锁动作&摸鱼待机动作配置上线', desc: '给动作设置播完之后接着放哪些动作，支持排序、增删、播放几遍、间隔多久、要不要循环；还能单独给龙虾挑一个摆烂待机动作' },
      { type: 'feature', title: 'AI学会改动作，不再从零瞎编', desc: '动作编辑器加AI指令输入框，可以在现有动作基础上发号施令微调，不用每次都让AI白手起家造动作' },
      { type: 'feature', title: '动作播放速度倍率调节', desc: '调速开关就位！默认1倍速，小于1就慢动作耍帅，编辑器和播放全都生效，老动作自动兼容不会翻车' },
      { type: 'feature', title: 'AI生成动作自动贴到时间轴上', desc: 'AI产出动作后，关键帧自动画在时间轴，自动跳到第一帧，不用自己手动到处找帧' },
      { type: 'feature', title: '模型渲染清晰度自由调节', desc: '电脑性能好就高清帅气，配置一般就降画质保流畅，龙虾不疯狂啃CPU' },

      // ===== 优化功能 =====
      { type: 'improvement', title: '数字输入框升级加减步进小按钮', desc: '骨骼旋转、位移、关键帧时间等数字，全部换成−/+步进器，深色浅色主题都适配，点来点去调参更快乐' },
      { type: 'improvement', title: '动作列表图标统一颜值，深浅色主题兼容', desc: '排序、播放暂停换掉颜表情，统一项目SVG图标，跟着主题自动变色，颜值提升一大截' },
      { type: 'improvement', title: '“云端AI服务”改名「AI模型服务」', desc: '本地Ollama也在这里，改掉容易误会的名字，本地/远端模型一锅收纳' },
      { type: 'improvement', title: '一键接入区块加上人话说明', desc: '讲清楚它和添加提供商是什么关系，减少大家一脸懵的情况' },
      { type: 'improvement', title: 'AI识别能力升级，听得懂中文骨骼表情名', desc: '扩充海量中文骨骼、表情别名库，用中文命名AI也不会乱丢掉；严禁AI脑洞乱造不存在的骨骼名称' },

      // ===== 修复之前的 bug（1.0.3 之前就有的功能） =====
      { type: 'fix', title: '修好AI导入页各家模型厂商兼容大乱斗问题', desc: '内置各家厂商预设：OpenAI兼容、Ollama、阿里云百炼、腾讯云混元、DeepSeek、智谱GLM、百度千帆、Kimi等。选厂商自动填地址和默认模型，腾讯云这类兼容接口现在可以直接用' },
      { type: 'fix', title: '彻底没收所有弹窗的放大全屏按钮', desc: '之前部分弹窗还藏着放大按钮，点完布局直接发疯。现在全部删掉，弹窗老老实实做好自己本分' },
      { type: 'fix', title: '想明白了一件事情后面其实也没什么', desc: '现在就不会挡到你操作了吧，虽然你很菜' },

      // ===== 本次追加修复 =====
      { type: 'fix', title: 'BongoCat头发玩消失，一秒光头一秒秀发', desc: '头发已续费' },
      { type: 'fix', title: 'BongoCat眼球跟你对着干，你左它右你上它下', desc: '眼科已挂号' },
      { type: 'fix', title: 'BongoCat左手抽风，按键认不全就乱缩', desc: '手不抽风了' },
      { type: 'fix', title: '透明度重置键是摆设，非得重启才听话', desc: '重置键终于好使了' },
      { type: 'fix', title: '切换模型把默认透明度也拐跑了，再也回不去', desc: '不再交叉感染' },
      { type: 'fix', title: '模型都重置了还在那若隐若现装幽灵', desc: '不再装幽灵' },
      { type: 'fix', title: '退出弹窗被模型吃掉一半，确认按钮都点不到', desc: '弹窗逃出魔掌' },
      { type: 'fix', title: '关于页面版本号一片空白，像被橡皮擦蹭了', desc: '版本号不再社恐' },
      { type: 'fix', title: '换3D模型旧的赖着不走，两个叠一起演皮影戏', desc: '该退场就退场' },
      { type: 'fix', title: '点击穿透只穿了个寂寞，模型还在那挡着', desc: '真·穿透到位' },
      { type: 'fix', title: '部分电脑卸载直接翻车，弹一串看不懂的错', desc: '卸载不再跑路' }
    ]
  },
  {
    version: '1.0.3',
    date: '2026-08-10',
    title: '龙虾修理工上岗，一堆疑难杂症被钳子夹走',
    changes: [
      { type: 'feature', title: '渲染帧率自由选择', desc: '30/60/120FPS随便挑，追求丝滑或者省电保性能，由你说了算' },
      { type: 'improvement', title: '关于页面重新装修排版', desc: '逻辑更通顺，找信息不再东翻西找' },
      { type: 'fix', title: '修复不打开主界面宠物模型位置直接跑偏', desc: '宠物窗口尺寸跟着配置走，渲染器老老实实读取正确窗口大小，龙虾不再乱跑' },
      { type: 'fix', title: '修复点程序图标唤不醒主界面', desc: '已经开着软件的时候，点图标优先把主界面弹出来，宠物窗口也保证看得见' },
      { type: 'fix', title: '给AI默认提示词做升级补课', desc: '补全角色设定，AI说话更靠谱，少输出虾言虾语' },
      { type: 'feature', title: '多会话聊天管理上线', desc: '新建、切换、删除对话随便玩，控件风格和模型选择器统一，旧聊天记录自动搬家不丢失' },
      { type: 'improvement', title: '更新公告学会自动折叠', desc: '默认只看最新版本，历史版本手动点开，页面不再长到滑不到底' }
    ]
  },
  {
    version: '1.0.2',
    date: '2026-08-08',
    title: '龙虾体型失控紧急补丁',
    changes: [
      { type: 'fix', title: '修复模型点击热区过大，挡住桌面点不动别的东西' },
      { type: 'fix', title: '修复程序莫名其妙霸占前台抢焦点' },
      { type: 'fix', title: '修复开机自启就强行蹦出主页窗口' }
    ]
  },
  {
    version: '1.0.2',
    date: '2026-08-07',
    title: '中英双语自由切换 + 一堆设置bug大清扫',
    changes: [
      { type: 'feature', title: '中英文实时切换，秒换语言不用重启', desc: '设置页切语言立刻全局翻译，龙虾秒懂两种语言，不用重启软件' },
      { type: 'fix', title: '修复设置改完不保存、不生效的摆烂行为', desc: '外观、主题、语言、开机自启等设置，修改完立刻保存立刻生效' },
      { type: 'fix', title: '修复开关乱跳误触发保存设置', desc: '聊天流式输出这类非设置面板开关，不会瞎触发保存逻辑了' },
      { type: 'fix', title: '重置/导入配置界面躺平不刷新问题修复', desc: '重置或者导入配置后，界面自动刷新，语言主题直接就位' },
      { type: 'improvement', title: '优化启动加载设置流程', desc: '一开软件自动加载保存好的主题语言，不用手动再点一遍' },
      { type: 'fix', title: '修复宠物触摸判定范围太大', desc: '点宠物空白背景不会乱触发交互，只有点到龙虾本体才会响应' },
      { type: 'fix', title: '修复部分设置改了跟没改一样', desc: '修好了配置键名错位，设置终于可以正常保存干活' },
      { type: 'fix', title: '软件管理空页面提示和模型管理撞脸问题', desc: '软件管理现在拥有专属空状态文案，不再傻傻分不清页面' },
      { type: 'fix', title: '修复文件管理搜索功能摆烂罢工', desc: '文件搜索满血复活，可以递归搜索目录里面的文件' },
      { type: 'fix', title: '底部状态栏模型名字原地不更新', desc: '切换模型，状态栏立刻跟上显示当前是哪只龙虾' },
      { type: 'fix', title: 'AI对话不会自动选已配置好的模型', desc: '有配置好的AI服务商，启动自动选中第一个可用模型' },
      { type: 'fix', title: '免责声明弹窗逻辑修复', desc: '首次打开独立弹窗展示，必须勾选同意才能继续撸龙虾' },
      { type: 'fix', title: 'AI聊天记录不会本地存档，重启直接失忆', desc: '对话自动存本地，重启打开历史聊天还在，龙虾不会彻底失忆' },
      { type: 'improvement', title: '软件管理增加搜索过滤', desc: '可以搜索筛选本机软件，不用眼睛挨个扫列表' },
      { type: 'improvement', title: '文件管理新增网格视图', desc: '列表/网格两种视图自由切换，看文件更舒服' },
      { type: 'improvement', title: '配置导入导出功能完工', desc: '备份、导入你的龙虾全部配置，搬家换电脑超方便' }
    ]
  },
  {
    version: '1.0.1',
    date: '2026-08-07',
    title: '测试尝鲜版！龙虾还在成长中，一切皆可变',
    changes: [
      { type: 'feature', title: '新增更新公告专属页面', desc: '侧边栏多出更新公告入口，翻阅龙虾全部进化历史' },
      { type: 'feature', title: '新版本自动弹更新公告', desc: '升级新版本打开，自动弹出更新日志，看看龙虾又学会什么新活' },
      { type: 'fix', title: '修复程序可以复制多开，一堆龙虾挤满桌面' },
      { type: 'fix', title: '修复不能老老实实缩到托盘后台摸鱼' },
      { type: 'fix', title: '收拾一批其他已知小毛病' }
    ]
  }
];


function getChangelog() {
  return CHANGELOG;
}

function getLatestVersion() {
  return CHANGELOG.length > 0 ? CHANGELOG[0].version : '0.0.0';
}

module.exports = { getChangelog, getLatestVersion };
