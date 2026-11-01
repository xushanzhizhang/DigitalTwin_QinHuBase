import os,json,copy,zipfile
import numpy as np, trimesh, pandas as pd
BASE='/mnt/data/qinhu_digital_twin'
MAIN=BASE+'/qinhu_base_digital_twin.glb'; SMART=BASE+'/qinhu_smart.glb'
# Keep 04 within the red frame: move weather station and side irrigation pipes closer to greenhouse.
move_x={
 '2168_小型气象站立杆':-12.0,'2169_气象站横臂':-12.0,'2170_气象站采集箱':-12.0,'2171_气象站风速风向组件':-12.0,
 '2172_灌溉支管':-4.0,'2173_灌溉支管':-4.0,'2174_灌溉支管':-4.0,'2175_灌溉支管':-4.0,
}
for path in [MAIN,SMART]:
    s=trimesh.load(path,force='scene')
    # The old smart-area polygonal concrete loop is not part of 04's actual footprint.
    if 'MERGED_smart_Weathered_concrete_46544' in s.graph.nodes_geometry:
        _,g=s.graph.get('MERGED_smart_Weathered_concrete_46544'); s.delete_geometry(g)
    for n,dx in move_x.items():
        if n in s.graph.nodes_geometry:
            _,g=s.graph.get(n)
            s.geometry[g].apply_translation([dx,0,0])
    s.metadata.update({'version':'6.2-smart-frame-fit-west-cropped','notes':'04 greenhouse and associated sensor/irrigation equipment are fitted within the user-marked frame; non-site loop path removed.'})
    s.export(path,file_type='glb')
    print('patched',os.path.basename(path),'bounds',s.bounds)
# manifest coordinates
mp=BASE+'/scene_manifest.json'; m=json.load(open(mp,encoding='utf-8'))
m['version']='6.2-smart-frame-fit-west-cropped'
for c in m.get('components',[]):
    nm=c.get('node_name','')
    if nm in move_x and c.get('position'):
        c['position'][0]=round(c['position'][0]+move_x[nm],2)
for f in m.get('facilities',[]):
    if f.get('object_id')=='QH-SMART-02168': f['position'][0]=16
    elif f.get('object_id')=='QH-SMART-02169': f['position'][0]=16
    elif f.get('object_id')=='QH-SMART-02170': f['position'][0]=16
    elif f.get('object_id')=='QH-SMART-02171': f['position'][0]=16
    elif f.get('object_id') in ['QH-SMART-02172','QH-SMART-02173','QH-SMART-02174','QH-SMART-02175']: f['position'][0]=15
m['front_end']='Three.js GLTFLoader; region focus, free orbit, object picking, facility panel and visibility toggles; v6.2 positions 04 and its sensor/irrigation assets inside the marked footprint and removes the unused loop path.'
json.dump(m,open(mp,'w',encoding='utf-8'),ensure_ascii=False,indent=2)
# CSV coordinates
cp=BASE+'/设施设备ID清单.csv'; df=pd.read_csv(cp)
for oid,dx in [(f'QH-SMART-{i}',move_x[nm]) for i,nm in [(2168,'2168_小型气象站立杆'),(2169,'2169_气象站横臂'),(2170,'2170_气象站采集箱'),(2171,'2171_气象站风速风向组件'),(2172,'2172_灌溉支管'),(2173,'2173_灌溉支管'),(2174,'2174_灌溉支管'),(2175,'2175_灌溉支管')]]:
    mask=df['对象ID']==oid
    df.loc[mask,'三维坐标X']=df.loc[mask,'三维坐标X']+dx
df.to_csv(cp,index=False,encoding='utf-8-sig')
# Update README and archive
rp=BASE+'/README.md'; readme=open(rp,encoding='utf-8').read().replace('v6.1','v6.2')
readme += '\n- 04 的气象站和灌溉支管进一步向棚体靠拢，旧的环形混凝土步道从独立 04 模型中移除。\n'
open(rp,'w',encoding='utf-8').write(readme)
zip_path='/mnt/data/琴湖基地_AI智慧农业_3D模型交付包_v6.2.zip'
with zipfile.ZipFile(zip_path,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for root,dirs,files in os.walk(BASE):
        for fn in files:
            if fn.endswith('.pyc') or fn.startswith('v5_backup_') or fn in ['patch_qinhu_model_v5.py','patch_qinhu_model_v6.py','patch_qinhu_model_v6_1.py','fix_hort_z_and_preview.py']:
                continue
            p=os.path.join(root,fn); z.write(p,os.path.relpath(p,BASE))
print('ZIP',zip_path,os.path.getsize(zip_path))
